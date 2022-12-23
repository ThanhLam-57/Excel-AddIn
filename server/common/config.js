// This is the default config. Any value in this file can be overridden by those given in ./dist/custom-config.json
// Don't change this file for customization, but use the JSON file instead.

module.exports = {
	title: "Quản Lý Chi Phí Và Khối Lượng Mỏ",
	version: "1.0",
	author: 'MICA',
	copyright: 'MICA',
	licensee: 'Công ty cổ phần than Mông Dương - Vinacomin',

	webServer: {
		portHttp: 80,
		portHttps: 443,
		path: '/klmo',
		publicAddress: 'http://localhost/klmo',
		sessionSecretKey: 'klmo',
		sessionMaxAge: 30 * 60 * 1000,	// in milliseconds
		logFormat: ':method :url :status :res[content-length] - :response-time ms',
		rememberLoginCookie: 'KLMO_LOGIN_INFO'
	},

	database: {
		host: 'localhost',
		schema: 'klmo',
		username: 'klmo',
		password: 'klmo',
	},

	rootUserId: 1,

	timeZoneOffset: (new Date()).getTimezoneOffset() * 60000,
	dateFormat: {
		moment: 'DD/MM/YYYY'
	},
	timeFormat: {
		moment: 'DD/MM/YYYY HH:mm:ss'
	},

	backupCronSchedule: '0 0 0 * * SUN',	// every Sunday at 00:00

	debug: (process.env.NODE_ENV === 'development')
};