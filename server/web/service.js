
var app = require('./startup');
var http = require('http');
var https = require('https');
var fs = require('fs');
var web = require('./public');
var config = require('../common/config');

app.set('port', config.webServer.portHttp);

web.serverHttp = http.createServer(app);
web.serverHttp.listen(config.webServer.portHttp);
web.serverHttp.on('error', onError);
web.serverHttp.on('listening', () => console.log(`HTTP server started on port ${config.webServer.portHttp}`));

if (config.webServer.portHttps >= 0) {
	const key = fs.readFileSync('dist/certs/selfsigned.key');
	const cert = fs.readFileSync('dist/certs/selfsigned.crt');

	web.serverHttps = https.createServer({ key, cert }, app);
	web.serverHttps.listen(config.webServer.portHttps);
	web.serverHttps.on('error', onError);
	web.serverHttps.on('listening', () => console.log(`HTTPS server started on port ${config.webServer.portHttps}`));
}


function onError(error) {
	if (error.syscall !== 'listen') {
		throw error;
	}

	// handle specific listen errors with friendly messages
	switch (error.code) {
	case 'EACCES':
		console.error('Port requires elevated privileges');
		process.exit(1);
		break;
	case 'EADDRINUSE':
		console.error('Port is already in use');
		process.exit(1);
		break;
	default:
		throw error;
	}
}

