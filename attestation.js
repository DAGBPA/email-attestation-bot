/*jslint node: true */
'use strict';
const constants = require('dag-pizza-dough/constants.js');
const conf = require('dag-pizza-dough/conf');
const db = require('dag-pizza-dough/db');
const eventBus = require('dag-pizza-dough/event_bus');
const validationUtils = require('dag-pizza-dough/validation_utils');
const mail = require('dag-pizza-dough/mail');
const texts = require('./modules/texts');
const reward = require('./modules/reward');
const conversion = require('./modules/conversion');
const emailAttestation = require('./modules/email_attestation');
const notifications = require('./modules/notifications');
const randomCryptoString = require('./modules/random-crypto-string');

/**
 * user pairs his device with bot
 */
eventBus.on('paired', (from_address) => {
	respond(from_address, '', texts.greeting());
});

/**
 * user sends message to the bot
 */
eventBus.once('headless_and_rates_ready', () => {  // we need rates to handle some messages
	const headlessWallet = require('headless-byteball');
	eventBus.on('text', (from_address, text) => {
		respond(from_address, text.trim());
	});
	if (conf.bRunWitness) {
		require('byteball-witness');
		eventBus.emit('headless_wallet_ready');
	} else {
		headlessWallet.setupChatEventHandlers();
	}
});

/**
 * user pays to the bot
 */
eventBus.on('new_my_transactions', handleNewTransactions);

/**
 * payment is confirmed
 */
eventBus.on('my_transactions_became_stable', handleTransactionsBecameStable);

/**
 * ready headless wallet
 */
eventBus.once('headless_wallet_ready', handleWalletReady);

function handleWalletReady() {
	let error = '';

	/**
	 * check if database tables is created
	 */
	let arrTableNames = [
		'users','receiving_addresses','transactions','verification_emails','attestation_units','rejected_payments',
		'reward_units','referral_reward_units'
	];
	db.query("SELECT name FROM sqlite_master WHERE type='table' AND NAME IN (?)", [arrTableNames], (rows) => {
		if (rows.length !== arrTableNames.length) {
			error += texts.errorInitSql();
		}

		/**
		 * check if config is filled correct
		 */
		if (conf.bUseSmtp && (!conf.smtpHost || !conf.smtpUser || !conf.smtpPassword)) {
			error += texts.errorConfigSmtp();
		}
		if (!conf.admin_email || !conf.from_email || !conf.attestation_from_email) {
			error += texts.errorConfigEmail();
		}
		if (!conf.salt) {
			error += texts.errorConfigSalt();
		}

		if (error) {
			throw new Error(error);
		}

		const headlessWallet = require('headless-byteball');
		const split = require('headless-byteball/split.js');
		headlessWallet.issueOrSelectAddressByIndex(0, 0, (address1) => {
			console.log('== email attestation address: ' + address1);
			emailAttestation.emailAttestorAddress = address1;

			headlessWallet.issueOrSelectAddressByIndex(0, 1, (address2) => {
				console.log('== distribution address: ' + address2);
				reward.distributionAddress = address2;
				split.startCheckingAndSplittingLargestOutput(reward.distributionAddress);

				setInterval(emailAttestation.retryPostingAttestations, 60*1000);
				setInterval(reward.retrySendingRewards, 60*1000);
				setInterval(retrySendingEmails, 60*1000);
				setInterval(moveFundsToAttestorAddresses, 60*1000);
			});
		});
	});
}

function moveFundsToAttestorAddresses() {
	let network = require('dag-pizza-dough/network.js');
	if (network.isCatchingUp())
		return;

	console.log('moveFundsToAttestorAddresses');
	db.query(
		`SELECT DISTINCT receiving_address
		FROM receiving_addresses 
		CROSS JOIN outputs ON receiving_address = address 
		JOIN units USING(unit)
		WHERE is_stable=1 AND is_spent=0 AND asset IS NULL
		LIMIT ?`,
		[constants.MAX_AUTHORS_PER_UNIT],
		(rows) => {
			// console.error('moveFundsToAttestorAddresses', rows);
			if (rows.length === 0) {
				return;
			}

			let arrAddresses = rows.map(row => row.receiving_address);
			// console.error(arrAddresses, emailAttestation.emailAttestorAddress);
			let headlessWallet = require('headless-byteball');
			headlessWallet.sendMultiPayment({
				asset: null,
				to_address: emailAttestation.emailAttestorAddress,
				send_all: true,
				paying_addresses: arrAddresses
			}, (err, unit) => {
				if (err) {
					console.error("failed to move funds: " + err);
					let balances = require('dag-pizza-dough/balances');
					balances.readBalance(arrAddresses[0], (balance) => {
						console.error('balance', balance);
						notifications.notifyAdmin('failed to move funds', err + ", balance: " + JSON.stringify(balance));
					});
				} else
					console.log("moved funds, unit " + unit);
			});
		}
	);
}

function retrySendingEmails() {
	db.query(
		`SELECT 
			code, user_email, transaction_id,
			device_address
		FROM verification_emails
		JOIN transactions USING(transaction_id)
		JOIN receiving_addresses USING(receiving_address, user_email)
		WHERE is_sent = 0 AND result IS NULL
		ORDER BY verification_emails.creation_date ASC`,
		(rows) => {
			rows.forEach((row) => {
				sendVerificationCodeToEmailAndMarkIsSent(row.user_email, row.code, row.transaction_id, row.device_address);
			});
		}
	);
}

function handleNewTransactions(arrUnits) {
	let device = require('dag-pizza-dough/device.js');
	db.query(
		`SELECT
			amount, asset, unit,
			receiving_address, device_address, user_address, user_email, price, 
			${db.getUnixTimestamp('last_price_date')} AS price_ts
		FROM outputs
		CROSS JOIN receiving_addresses ON receiving_addresses.receiving_address = outputs.address
		WHERE unit IN(?)
			AND NOT EXISTS (
				SELECT 1
				FROM unit_authors
				CROSS JOIN my_addresses USING(address)
				WHERE unit_authors.unit = outputs.unit
			)`,
		[arrUnits],
		(rows) => {
			rows.forEach((row) => {

				checkPayment(row, (error) => {
					if (error) {
						return db.query(
							`INSERT ${db.getIgnore()} INTO rejected_payments
							(receiving_address, price, received_amount, payment_unit, error)
							VALUES (?,?,?,?,?)`,
							[row.receiving_address, row.price, row.amount, row.unit, error],
							() => {
								device.sendMessageToDevice(row.device_address, 'text', error);
							}
						);
					}

					db.query(
						`INSERT INTO transactions
						(receiving_address, price, received_amount, payment_unit)
						VALUES (?,?,?,?)`,
						[row.receiving_address, row.price, row.amount, row.unit],
						() => {
							device.sendMessageToDevice(row.device_address, 'text', texts.receivedYourPayment(row.amount));
						}
					);

				}); // checkPayment

			});
		}
	);
}

function checkPayment(row, onDone) {
	if (row.asset !== null) {
		return onDone("Received payment in wrong asset");
	}

	if (row.amount < conf.priceInPizza) {
		let text = `Received ${row.amount} Pizza from you, which is less than the expected ${conf.priceInPizza} Pizza.`;
		return onDone(text + '\n\n' + texts.pleasePay(row.receiving_address, conf.priceInPizza));
	}

	function resetUserAddress(){
		db.query("UPDATE users SET user_address=NULL WHERE device_address=?", [row.device_address]);
	}
	
	db.query("SELECT address FROM unit_authors WHERE unit=?", [row.unit], (author_rows) => {
		if (author_rows.length !== 1){
			resetUserAddress();
			return onDone("Received a payment but looks like it was not sent from a single-address wallet.  "+texts.switchToSingleAddress());
		}
		if (author_rows[0].address !== row.user_address){
			resetUserAddress();
			return onDone("Received a payment but it was not sent from the expected address "+row.user_address+".  "+texts.switchToSingleAddress());
		}
		onDone();
	});
}

function handleTransactionsBecameStable(arrUnits) {
	let device = require('dag-pizza-dough/device.js');
	db.query(
		`SELECT 
			transaction_id, 
			device_address, user_address, user_email
		FROM transactions
		JOIN receiving_addresses USING(receiving_address)
		WHERE payment_unit IN(?)`,
		[arrUnits],
		(rows) => {
			rows.forEach((row) => {
				db.query(
					`UPDATE transactions 
					SET confirmation_date=${db.getNow()}, is_confirmed=1 
					WHERE transaction_id=?`,
					[row.transaction_id],
					() => {
						device.sendMessageToDevice(row.device_address, 'text', texts.paymentIsConfirmed());

						/**
						 * create and send verification code to attestation email
						 */
						const verificationCode = randomCryptoString.generateByLengthSync(10);

						db.query(
							`INSERT INTO verification_emails 
							(transaction_id, user_email, code) 
							VALUES(?,?,?)`,
							[row.transaction_id, row.user_email, verificationCode],
							() => {
								sendVerificationCodeToEmailAndMarkIsSent(row.user_email, verificationCode, row.transaction_id, row.device_address);
							}
						);

					}
				);
			});
		}
	);
}

function sendVerificationCodeToEmailAndMarkIsSent(user_email, code, transaction_id, device_address) {
	let device = require('dag-pizza-dough/device.js');
	mail.sendmail({
		from: `${conf.attestation_from_name ? conf.attestation_from_name + ' ' : ''}<${conf.attestation_from_email}>`,
		to: user_email,
		subject: texts.verificationEmailSubject(),
		body: texts.verificationEmailText(code),
		htmlBody: texts.verificationEmailHtml(code)
	}, (err) => {
		if (err) {
			console.error(err);
			return notifications.notifyAdmin('failed to send mail', `failed to send mail to ${user_email}: ${err}`);
		}

		db.query(
			`UPDATE verification_emails 
			SET is_sent=?
			WHERE transaction_id=? AND user_email=?`,
			[1, transaction_id, user_email],
			() => {
				device.sendMessageToDevice(device_address, 'text', texts.emailWasSent(user_email));
			}
		);
	});
}

/**
 * scenario for responding to user requests
 * @param from_address
 * @param text
 * @param response
 */
function respond (from_address, text, response = '') {
	let device = require('dag-pizza-dough/device.js');
	const mutex = require('dag-pizza-dough/mutex.js');
	readUserInfo(from_address, (userInfo) => {

		function checkUserAddress(onDone) {
			if (validationUtils.isValidAddress(text)) {
				userInfo.user_address = text;
				response += texts.goingToAttestAddress(userInfo.user_address);
				return db.query(
					'UPDATE users SET user_address=? WHERE device_address=?',
					[userInfo.user_address, from_address],
					() => {
						onDone();
					}
				);
			}
			if (userInfo.user_address) return onDone();
			onDone(texts.insertMyAddress());
		}

		function checkUserEmail(onDone) {
			if (validationUtils.isValidEmail(text)) {
				userInfo.user_email = text.toLowerCase();
				response += texts.goingToAttestEmail(userInfo.user_email);
				return db.query(
					'UPDATE users SET user_email=? WHERE device_address=? AND user_address=?',
					[userInfo.user_email, from_address, userInfo.user_address],
					() => {
						onDone();
					}
				);
			}
			if (userInfo.user_email) return onDone();
			onDone(texts.insertMyEmail());
		}

		checkUserAddress((userAddressResponse) => {
			if (userAddressResponse) {
				return device.sendMessageToDevice(from_address, 'text', (response ? response + '\n\n' : '') + userAddressResponse);
			}

			checkUserEmail((userEmailResponse) => {
				if (userEmailResponse) {
					return device.sendMessageToDevice(from_address, 'text', (response ? response + '\n\n' : '') + userEmailResponse);
				}

				readOrAssignReceivingAddress(from_address, userInfo, (receiving_address, post_publicly) => {
					let price = conf.priceInPizza;

					if (text === 'private' || text === 'public') {
						post_publicly = (text === 'public') ? 1 : 0;
						db.query(
							`UPDATE receiving_addresses 
							SET post_publicly=? 
							WHERE device_address=? AND user_address=? AND user_email=?`,
							[post_publicly, from_address, userInfo.user_address, userInfo.user_email]
						);
						response += (text === "private") ? texts.privateChosen() : texts.publicChosen(userInfo.user_email);
					}

					if (post_publicly === null) {
						return device.sendMessageToDevice(from_address, 'text', (response ? response + '\n\n' : '') + texts.privateOrPublic());
					}

					if (text === 'again') {
						return device.sendMessageToDevice(
							from_address,
							'text',
							(response ? response + '\n\n' : '') + texts.pleasePay(receiving_address, price) + '\n\n' +
							((post_publicly === 0) ? texts.privateChosen() : texts.publicChosen(userInfo.user_email))
						);
					}

					db.query(
						`SELECT
							transaction_id, is_confirmed, received_amount, user_address, user_email,
							code, result, attestation_date
						FROM transactions
						JOIN receiving_addresses USING(receiving_address)
						LEFT JOIN verification_emails USING(transaction_id, user_email)
						LEFT JOIN attestation_units USING(transaction_id)
						WHERE receiving_address=?
						ORDER BY transaction_id DESC
						LIMIT 1`,
						[receiving_address],
						(rows) => {
							/**
							 * if user didn't pay yet
							 */
							if (rows.length === 0) {
								return device.sendMessageToDevice(
									from_address,
									'text',
									(response ? response + '\n\n' : '') + texts.pleasePayOrPrivacy(receiving_address, price, post_publicly)
								);
							}

							let row = rows[0];
							let transaction_id = row.transaction_id;

							/**
							 * if user paid, but transaction did not become stable
							 */
							if (row.is_confirmed === 0) {
								return device.sendMessageToDevice(
									from_address,
									'text',
									(response ? response + '\n\n' : '') + texts.receivedYourPayment(row.received_amount)
								);
							}

							let email_verification_result = row.result;
							/**
							 * if user still did not enter correct verification code
							 */
							if (email_verification_result === null) {

								/**
								 * user wants to receive email again
								 */
								if (text === 'send email again') {
									return db.query(
										`UPDATE verification_emails 
										SET is_sent=0
										WHERE transaction_id=?`,
										[transaction_id],
										() => {
											sendVerificationCodeToEmailAndMarkIsSent(row.user_email, row.code, transaction_id, from_address);
										}
									);
								} else if (text === 'private' || text === 'public') {

									return device.sendMessageToDevice(from_address, 'text', response);

								} else {

									return mutex.lock(['tx-'+transaction_id], (unlock) => {

										/**
										 * check again verification email result
										 */
										db.query(
											`SELECT
												payment_unit,
												post_publicly,
												code, result, number_of_attempts, user_email
											FROM transactions
											JOIN receiving_addresses USING(receiving_address)
											LEFT JOIN verification_emails USING(transaction_id, user_email)
											WHERE receiving_address=? AND transaction_id=?
											LIMIT 1`,
											[receiving_address, transaction_id],
											(rows) => {
												let row = rows[0];

												if (row.result !== null)
													return unlock(true);
												
												/**
												 * if user still did not enter correct verification code
												 */

												/**
												 * if user enters correct verification code
												 */
												if (text === row.code) {

													return db.query(
														`UPDATE verification_emails 
														SET result=1, result_date=${db.getNow()}
														WHERE transaction_id=?`,
														[transaction_id],
														() => {
															unlock(false);

															device.sendMessageToDevice(
																from_address,
																'text',
																(response ? response + '\n\n' : '') + texts.codeConfirmedEmailInAttestation(row.user_email)
															);

															db.query(
																`INSERT ${db.getIgnore()} INTO attestation_units 
																(transaction_id) 
																VALUES (?)`,
																[transaction_id],
																() => {

																	let	[attestation, src_profile] = emailAttestation.getAttestationPayloadAndSrcProfile(
																		userInfo.user_address,
																		row.user_email,
																		row.post_publicly
																	);

																	emailAttestation.postAndWriteAttestation(
																		transaction_id,
																		emailAttestation.emailAttestorAddress,
																		attestation,
																		src_profile
																	);

																	if (checkIsEmailQualifiedForReward(row.user_email) && conf.rewardInUSD) {
																		let rewardInPizza = conversion.getPriceInPizza(conf.rewardInUSD);
																		db.query(
																			`INSERT ${db.getIgnore()} INTO reward_units
																			(transaction_id, user_address, user_email, user_id, reward)
																			VALUES (?,?,?,?,?)`,
																			[transaction_id, userInfo.user_address, row.user_email, attestation.profile.user_id, rewardInPizza],
																			(res) => {
																				console.error(`reward_units insertId: ${res.insertId}, affectedRows: ${res.affectedRows}`);
																				if (!res.affectedRows) {
																					return console.log(`duplicate user_address or user_id: ${userInfo.user_address}, ${attestation.profile.user_id}`);
																				}

																				device.sendMessageToDevice(from_address, 'text', texts.attestedSuccessFirstTimeBonus(rewardInPizza));
																				reward.sendAndWriteReward('attestation', transaction_id);

																				if (conf.referralRewardInUSD) {
																					let referralRewardInPizza = conversion.getPriceInPizza(conf.referralRewardInUSD);
																					reward.findReferrer(row.payment_unit, userInfo.user_address, (referring_user_id, referring_user_address, referring_user_device_address) => {
																						if (!referring_user_address) {
																							// console.error("no referring user for " + row.user_address);
																							return console.log("no referring user for " + userInfo.user_address);
																						}

																						db.query(
																							`INSERT ${db.getIgnore()} INTO referral_reward_units
																							(transaction_id, user_address, user_id, new_user_address, new_user_id, reward)
																							VALUES (?, ?,?, ?,?, ?)`,
																							[transaction_id,
																								referring_user_address, referring_user_id,
																								userInfo.user_address, attestation.profile.user_id,
																								referralRewardInPizza],
																							(res) => {
																								console.log(`referral_reward_units insertId: ${res.insertId}, affectedRows: ${res.affectedRows}`);
																								if (!res.affectedRows) {
																									return notifications.notifyAdmin(
																										"duplicate referral reward",
																										`referral reward for new user ${userInfo.user_address} ${attestation.profile.user_id} already written`
																									);
																								}

																								device.sendMessageToDevice(referring_user_device_address, 'text', texts.referredUserBonus(referralRewardInPizza));
																								reward.sendAndWriteReward('referral', transaction_id);
																							}
																						);
																					});
																				} // if conf.referralRewardInUSD

																			}
																		);
																	} // if conf.rewardInPizza

																}
															);

														}
													);

												} else {
													/**
													 * if user enters wrong verification code
													 */
													let currNumberAttempts = Number(row.number_of_attempts) + 1;
													let leftNumberAttempts = conf.MAX_ATTEMPTS - currNumberAttempts;

													response = (response ? response + '\n\n' : '') + texts.wrongVerificationCode(leftNumberAttempts);

													if (leftNumberAttempts > 0) {
														return db.query(
															`UPDATE verification_emails 
															SET number_of_attempts=? 
															WHERE transaction_id=?`,
															[currNumberAttempts, transaction_id],
															() => {
																unlock(false);

																device.sendMessageToDevice(
																	from_address,
																	'text',
																	(response ? response + '\n\n' : '') + texts.emailWasSent(row.user_email)
																);

															}
														);
													} else {
														/**
														 * no more chance, attestation is failed
														 */
														return db.query(
															`UPDATE verification_emails 
															SET number_of_attempts=?, result=0, result_date=${db.getNow()}
															WHERE transaction_id=?`,
															[currNumberAttempts, transaction_id],
															() => {
																unlock(false);

																device.sendMessageToDevice(
																	from_address,
																	'text',
																	(response ? response + '\n\n' : '') + texts.currentAttestationFailed()
																);

															}
														);
													} // no more chance, attestation is failed

												} // user enters wrong verification code

											});

									}, (bIsNeededNextCall) => {
										if (bIsNeededNextCall)
											callLastScenarioChecks();
									}); // mutex.lock userInfo.user_address

								}
							} // if email_verification_result === null

							callLastScenarioChecks();

							function callLastScenarioChecks() {
								/**
								 * previous attestation was failed
								 */
								if (email_verification_result === 0) {
									return device.sendMessageToDevice(
										from_address,
										'text',
										(response ? response + '\n\n' : '') + texts.previousAttestationFailed()
									);
								}

								/**
								 * email is in attestation
								 */
								if (!row.attestation_date) {
									return device.sendMessageToDevice(
										from_address,
										'text',
										(response ? response + '\n\n' : '') + texts.codeConfirmedEmailInAttestation(row.user_email)
									);
								}

								/**
								 * no more available commands, user email is attested
								 */
								return device.sendMessageToDevice(
									from_address,
									'text',
									(response ? response + '\n\n' : '') + texts.alreadyAttested(row.attestation_date)
								);
							}

						}
					);

				});
			});
		});
	});
}

function checkIsEmailQualifiedForReward(email) {
	let objRewardWhiteListEmails = conf.objRewardWhiteListEmails;
	for (let key in objRewardWhiteListEmails) {
		if (!objRewardWhiteListEmails.hasOwnProperty(key)) continue;
		console.error('checkIsEmailQualifiedForReward', objRewardWhiteListEmails[key].test(email), email, objRewardWhiteListEmails[key]);
		if (objRewardWhiteListEmails[key].test(email)) {
			return true;
		}
	}
	return false;
}

/**
 * get user's information by device address
 * or create new user, if it's new device address
 * @param device_address
 * @param callback
 */
function readUserInfo (device_address, callback) {
	db.query('SELECT user_address, user_email FROM users WHERE device_address = ?', [device_address], (rows) => {
		if (rows.length) {
			callback(rows[0]);
		} else {
			db.query(`INSERT ${db.getIgnore()} INTO users (device_address) VALUES(?)`, [device_address], () => {
				callback({ device_address, user_address: null });
			});
		}
	});
}

/**
 * read or assign receiving address
 * @param device_address
 * @param userInfo
 * @param callback
 */
function readOrAssignReceivingAddress(device_address, userInfo, callback) {
	const mutex = require('dag-pizza-dough/mutex.js');
	mutex.lock([device_address], (unlock) => {
		db.query(
			`SELECT receiving_address, post_publicly, ${db.getUnixTimestamp('last_price_date')} AS price_ts
			FROM receiving_addresses 
			WHERE device_address=? AND user_address=? AND user_email=?`,
			[device_address, userInfo.user_address, userInfo.user_email],
			(rows) => {
				if (rows.length > 0) {
					let row = rows[0];
					callback(row.receiving_address, row.post_publicly);
					return unlock();
				}

				const headlessWallet = require('headless-byteball');
				headlessWallet.issueNextMainAddress((receiving_address) => {
					db.query(
						`INSERT INTO receiving_addresses 
						(device_address, user_address, user_email, receiving_address, price, last_price_date) 
						VALUES(?,?,?,?,?,${db.getNow()})`,
						[device_address, userInfo.user_address, userInfo.user_email, receiving_address, conf.priceInPizza],
						() => {
							callback(receiving_address, null);
							unlock();
						}
					);
				});
			}
		);
	});
}