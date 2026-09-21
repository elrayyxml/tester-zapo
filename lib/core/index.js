'use strict';

const { Client } = require('./client');
const messaging = require('./messaging');

module.exports = { Client, ...messaging };
