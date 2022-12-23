const createError = require('http-errors');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const expressSession = require('express-session');
const FileStore = require('session-file-store')(expressSession);
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const fsRotator = require('file-stream-rotator')
const moment = require('moment');

const config = require('../common/config');
const common = require('../common/common');
const utils = require('./utils');


const app = express();

// static route
app.use(config.webServer.path, express.static('./dist/public'));
app.use(config.webServer.path + '/office', express.static('./node_modules/@microsoft/office-js/dist'));


const mainRouter = require('./routes/main');
const excelRouter = require('./routes/excel');

// view engine setup
app.set('views', './dist/views');
app.set('view engine', 'ejs');

app.use(cookieParser());
app.use(expressSession({
	store: new FileStore({path: './dist/tmp/sessions'}),
	secret: config.webServer.sessionSecretKey,
	saveUninitialized: false,
	resave: true,
	cookie: {
		maxAge: config.webServer.sessionMaxAge
	}
}));

app.use(express.json({ limit: '50mb' }));	// for parsing application/json
app.use(express.urlencoded({ extended: true, limit: '50mb', parameterLimit: 10000 }));	// for parsing application/x-www-form-urlencoded

app.use(utils.preRequestTasks);


// layout
app.use(expressLayouts);
app.set('layout', 'layout');
app.set('layout extractScripts', true);
app.set('layout extractStyles', true);

// take real remote IP address when working behind a reverse proxy
morgan.token('remote-addr', (req, res) => req.headers['x-forwarded-for'] || req.socket.remoteAddress);
morgan.token('local-date', (req, res) => moment().format('YYYY-MM-DD HH:mm:ss'));

app.use(morgan(':remote-addr [:local-date] ":method :url HTTP/:http-version" :status :res[content-length] :response-time ms ":referrer" ":user-agent"', {
	stream: fsRotator.getStream({
		date_format: 'YYYYMMDD',
		filename: './dist/tmp/log/access-%DATE%.log',
		frequency: 'daily',
		verbose: false
	})
}));
app.use(morgan('dev'));

// dynamic routes
app.use(config.webServer.path, mainRouter);
app.use(config.webServer.path + '/excel', excelRouter);


// catch 404 and forward to error handler
app.use(function(req, res, next) {
	next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
	// set locals, only providing error in development
	res.locals.message = err.message;
	res.locals.error = req.app.get('env') === 'development' ? err : {};

	// render the error page
	res.status(err.status || 500);
	res.render(err.status == '404' ? 'error-404' : 'error-hard', { title: 'Lỗi' });
});


common.checkSoftwareLicence();


module.exports = app;
