/*jslint node: true */
"use strict";
const check_daemon = require('dag-pizza-dough/check_daemon.js');

check_daemon.checkDaemonAndNotify('node attestation.js');

