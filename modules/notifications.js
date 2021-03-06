/*jslint node: true */
'use strict';
const conf = require('dag-pizza-dough/conf.js');
const mail = require('dag-pizza-dough/mail.js');
const emailjs = require('emailjs');

let server;

if (conf.bUseSmtp) {
	server = emailjs.server.connect({
		user: conf.smtpUser,
		password: conf.smtpPassword,
		host: conf.smtpHost,
		ssl: true
	});
}

function notifyAdmin(subject, body) {
	console.log('notifyAdmin:\n' + subject + '\n' + body);
	if (conf.bUseSmtp) {
		server.send({
			text: body,
			from: 'Server <' + conf.from_email + '>',
			to: 'You <' + conf.admin_email + '>',
			subject: subject
		}, function (err) {
			if (err) console.error(new Error(err));
		});
	} else {
		mail.sendmail({
			to: conf.admin_email,
			from: conf.from_email,
			subject: subject,
			body: body
		});
	}
}

exports.notifyAdmin = notifyAdmin;