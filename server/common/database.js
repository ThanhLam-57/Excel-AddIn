const config = require('./config');
const mysql = require('mysql');
const sqlstring = require('sqlstring');
const moment = require('moment');

let conn = null;


function connect() {
	if (conn != null) return;

	let __conn = mysql.createConnection({
		host: config.database.host,
		user: config.database.username,
		password: config.database.password,
		database: config.database.schema,
		insecureAuth : true
	});

	__conn.on('error', err => {
		if (err.code == 'PROTOCOL_CONNECTION_LOST') {
			// set to null to reconnect in the next query
			console.log('Database connection lost');
			conn = null;
		} else throw err;
	});

	return new Promise((resolve, reject) => {
		__conn.connect(err => {
			if (err) reject(err);
			else {
				conn = __conn;
				resolve();
			}
		});
	});
}

function escape(s) {
	return sqlstring.escape(s);
}

function toSqlDate(date) {
	return moment(date).format('YYYY-MM-DD');
}

function toSqlDatetime(date) {
	return moment(date).format('YYYY-MM-DD HH:mm:ss');
}

function query(sql, args) {
	if (conn == null) {
		console.log('Database connection not ready, connecting...');
		return connect().then(result => {
			return query(sql, args);
		});
	}

	return new Promise((resolve, reject) => {
		conn.query(sql, args, (err, rows) => {
			if (err) reject(err);
			resolve(rows);
		});
	}).catch(err => {
		if (config.debug) console.error(err);
	});
}


function queryValue(sql, args) {
	return query(sql, args).then(rows => {
		return rows.length == 0 ? null : Object.values(rows[0])[0];
	});
}


function queryRow(sql, args) {
	return query(sql, args).then(rows => {
		return (!rows || rows.length == 0) ? null : rows[0];
	});
}

function queryColumn(sql, args) {
	return query(sql, args).then(rows => {
		return rows.map(r => Object.values(r)[0]);
	});
}


module.exports = {
	connect,
	escape,
	toSqlDate,
	toSqlDatetime,
	query,
	queryValue,
	queryRow,
	queryColumn
};