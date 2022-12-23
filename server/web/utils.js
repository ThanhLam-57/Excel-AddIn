const moment = require('moment');
const config = require('../common/config');
const database = require('../common/database');
const common = require('../common/common');
const project = require('./project');
const crypto = require('crypto');






const USER_PERMISSIONS = [
	{ name: 'perm_administration',	desc: 'Quản trị hệ thống' },
	{ name: 'perm_manage_users',	desc: 'Quản trị người dùng' },
	{ name: 'perm_ky_thuat',		desc: 'Phòng kỹ thuật' },
	{ name: 'perm_ke_hoach',		desc: 'Phòng kế hoạch' },
	{ name: 'perm_vat_tu',			desc: 'Phòng vật tư' },
	{ name: 'perm_ke_toan',			desc: 'Phòng kế toán' },
	{ name: 'perm_kcs',				desc: 'Phòng KCS' },
	{ name: 'perm_phan_xuong',		desc: 'Phân xưởng' }
];

const DIVISION_TYPES = {
	ADMINISTRATION: 1,
	EXECUTION: 2
};


function divisionTypeName(t) {
	switch (t) {
	case DIVISION_TYPES.ADMINISTRATION:	return 'Hành chính';
	case DIVISION_TYPES.EXECUTION:		return 'Phân xưởng';
	}
}


async function loginByHash(ctx, hash) {
	const userId = await checkUserLoginHash(hash);
	if (userId) {
		ctx.req.session.userId = userId;
		await loadUserInfo(ctx);
		return true;
	}
	return false;
}

async function loadUserInfo(ctx) {
	// user information should not be stored in session, as it can be changed after the user has logged in
	// ==> load user information on every request
	const row = await database.queryRow('select u.id, u.login, u.full_name, u.create_time, u.last_login,' +
			' group_concat(distinct concat(d.id, "|", d.name) order by d.id) divisions,' +
			' group_concat(distinct concat(g.id, "|", g.name) order by g.id) user_groups,' +
			USER_PERMISSIONS.map(p => `max(g.${p.name}) ${p.name}`).join(',') +
			' from user u left outer join user_group_assoc ug on ug.user = u.id left outer join user_group g on g.id = ug.user_group ' +
			' left outer join user_division_assoc ud on ud.user = u.id left outer join division d on d.id = ud.division ' +
			` where u.id = ${ctx.req.session.userId} ` +
			' group by u.id');

	if (!row) {
		// something must go wrong!
		ctx.req.session.userId = null;
		return;
	}

	const userInfo = {
		id: row['id'],
		login: row['login'],
		fullName: row['full_name'],
		createTime: row['create_time'],
		lastLogin: row['last_login'],
		divisions: [],	// see below
		groups: [],	// see below
		perm: []	// see below
	};

	// collect divisions information
	if (row['divisions']) {
		userInfo.divisions = row['divisions'].split(',').map(d => {
			const [id, name] = d.split('|');
			return {
				id: parseInt(id),
				name
			};
		});
	}

	// collect user groups information
	if (row['user_groups']) {
		userInfo.groups = row['user_groups'].split(',').map(g => {
			const [id, name] = g.split('|');
			return {
				id: parseInt(id),
				name
			};
		});
	}

	// collect user permissions
	for (const p of USER_PERMISSIONS) {
		userInfo.perm[p.name] = row['perm_administration'] || row[p.name];
	}

	ctx.res.locals.user = userInfo;
}


async function preRequestTasks(req, res, next) {
	if (common.isUnderMaintenance())
		return res.send('Hệ thống đang bảo trì, xin quay lại sau.');


	res.locals.ctx = {req, res};
	res.locals.config = config;

	res.locals.utils = toBeExported;
	res.locals.moment = moment;
	res.locals.project = project;

	if (req.session.userId == null) {
		if (res.locals.user) delete res.locals.user;

		// try to login by cookie
		const loginCookie = req.cookies[config.webServer.rememberLoginCookie];
		if (loginCookie) await loginByHash({req, res}, loginCookie);
	}

	if (req.session.userId) await loadUserInfo({req, res});

	next();
}

function errorPage(ctx, msg) {
	ctx.res.render('error-soft', {
		title: 'Lỗi',
		message: msg
	});
}

function noticePage(ctx, title, msg) {
	ctx.res.render('notice', {
		title,
		message: msg
	});
}

function isLoggedIn(ctx) {
	return ctx.req.session.userId != undefined && ctx.req.session.userId != null;
}

function getUserId(ctx) {
	return ctx.req.session.userId;
}

function checkStrongPassword(pwd) {
	return pwd.length >= 6 && /^[\x00-\x7F]*$/.test(pwd);
}



async function generateUserLoginHash(userId) {
	const pwd = await database.queryValue('select password from user where id = ?', [userId]);
	if (pwd == null) return;

	const generateRandomString = length => {
		const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		return Array(length).fill(0).map(e => charset.charAt(Math.floor(Math.random() * charset.length))).join('');
	};

	const salt = generateRandomString(16),
		nonce = crypto.randomUUID();

	const res = await database.query('insert into user_login_hash set user=?, salt=?, nonce=?, hash = sha2(concat(?,?,?), 256), create_time=now(), expire=null', [userId, salt, nonce, pwd, salt, nonce]);
	const hash = await database.queryValue('select hash from user_login_hash where id=?', [res.insertId]);
	return `${nonce}.${hash}`;
}

async function checkUserLoginHash(nonceAndHash) {
	const loginInfo = nonceAndHash.split('.');
	if (loginInfo.length != 2) return null;

	return await database.queryValue('select u.id from user u join user_login_hash h on u.id = h.user where nonce=? and sha2(concat(password, salt, nonce), 256) = ? and deactivate_time is null',
		[loginInfo[0], loginInfo[1]]);
}

function hasPermission(ctx, permission) {
	return isLoggedIn(ctx) && ctx.res.locals.user.perm[permission];
}

function hasAnyPermission(ctx, permission) {
	if (!isLoggedIn(ctx)) return false;
	
	for (const p of permission)
		if (ctx.res.locals.user.perm[p]) return true;

	return false;
}

function hasAllPermission(ctx, permission) {
	if (!isLoggedIn(ctx)) return false;
	
	for (const p of permission)
		if (!ctx.res.locals.user.perm[p]) return false;

	return true;
}


function checkLoggedIn(ctx) {
	if (!isLoggedIn(ctx)) {
		errorPage(ctx, 'Bạn chưa đăng nhập.');
		return false;
	}
	
	return true;
}

function checkPermission(ctx, permission) {
	if (!hasPermission(ctx, permission)) {
		errorPage(ctx, 'Bạn không có quyền truy cập trang này.');
		return false;
	}
	
	return true;
}

function checkAnyPermission(ctx, permission) {
	if (!hasAnyPermission(ctx, permission)) {
		errorPage(ctx, 'Bạn không có quyền truy cập trang này.');
		return false;
	}
	
	return true;
}

function checkAllPermission(ctx, permission) {
	if (!hasAllPermission(ctx, permission)) {
		errorPage(ctx, 'Bạn không có quyền truy cập trang này.');
		return false;
	}
	
	return true;
}




function getDownloadFilePath(filename) {
	return `dist/data/download/${filename}`;
}
function makeUrl(url) {
	return config.webServer.path + url;
}


function ajaxError(ctx, msg) {
	ctx.res.json({
		msg
	});
}

function ajaxOk(ctx, data) {
	ctx.res.json({
		msg: 'OK',
		data
	});
}



function queryUserList(criteria) {
	return database.query('select u.*,' +
		' group_concat(distinct concat(d.id, "|", d.name) order by d.id) divisions,' +
		' group_concat(distinct concat(g.id, "|", g.name) order by g.id) user_groups' +
		' from user u left outer join user_division_assoc ud on ud.user = u.id left outer join division d on ud.division = d.id' +
		' left outer join user_group_assoc ug on ug.user = u.id left outer join user_group g on ug.user_group = g.id' +
		` where 1 ${criteria ? ' and ' + criteria : ''}` +
		' group by u.id' +
		' order by full_name');
}



const toBeExported = {
	USER_PERMISSIONS,
	DIVISION_TYPES,

	divisionTypeName,

	preRequestTasks,
	errorPage,
	noticePage,

	isLoggedIn,
	getUserId,
	checkStrongPassword,
	generateUserLoginHash,
	checkUserLoginHash,
	loginByHash,

	hasPermission,
	hasAnyPermission,
	hasAllPermission,
	checkLoggedIn,
	checkPermission,
	checkAnyPermission,
	checkAllPermission,

	getDownloadFilePath,
	makeUrl,

	ajaxError,
	ajaxOk,

	queryUserList
}

module.exports = toBeExported;