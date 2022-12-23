const express = require('express');
const config = require('../../common/config');
const database = require('../../common/database');
const common = require('../../common/common');
const utils = require('../utils');
const project = require('../project');
const moment = require('moment');
const fs = require('fs');


const router = express.Router();





router.all('/', (req, res) => {
	res.render('index', {});
});


router.all('/about', (req, res) => {
	res.render('about', {
		title: 'Giới thiệu'
	});
});



// ajax
router.all('/logout', (req, res) => {
	if (!utils.isLoggedIn({req, res}))
		return utils.ajaxError({req, res}, 'Không có quyền.');

	delete req.session.userId;
	res.clearCookie(config.webServer.rememberLoginCookie);
//	res.redirect(req.body.backUrl ? req.body.backUrl : utils.makeUrl(''));
	utils.ajaxOk({req, res});
});


router.all('/login', async (req, res) => {
	if (utils.isLoggedIn({req, res}))
		return utils.errorPage({req, res}, 'Bạn đã đăng nhập bằng tài khoản: ' + res.locals.user.login);

	const params = {
		username: req.body.username ? req.body.username.trim() : null,
		password: req.body.password,
		remember: req.body.remember == 'ON',
		backUrl: req.body.backUrl ? req.body.backUrl.trim() : null
	};

	const data = {
		params,
		errors: []
	};

	if (req.method != 'POST') return res.render('login', data);

	if (!params.username) data.errors.push('Chưa xác định tên đăng nhập.');
	if (!params.password) data.errors.push('Chưa nhập mật khẩu.');
	if (data.errors.length > 0) return res.render('login', data);

	try {
		const userInfo = await database.queryRow('select id, password, deactivate_time from user where login = ? and password = sha2(?, 256)', [params.username, params.password]);
		if (!userInfo) {
			data.errors.push('Tên đăng nhập hoặc mật khẩu không đúng.');
			return res.render('login', data);
		}

		if (userInfo.deactivate_time) {
			data.errors.push('Tài khoản đã bị khoá.');
			return res.render('login', data);
		}

		req.session.userId = parseInt(userInfo.id);
		await new Promise(resolve => {
			req.session.save(resolve);
		});

		if (params.remember) {
			const loginNonceAndHash = await utils.generateUserLoginHash(userInfo.id);

			const maxAge = 365 * 24 * 3600 * 1000;
			res.cookie(config.webServer.rememberLoginCookie, loginNonceAndHash, {
				expire: new Date(Date.now() + maxAge),
				maxAge,
				SameSite: 'none',
				secure: false
			});
		}

		await database.query('update user set last_login = now() where id = ?', [req.session.userId]);
		res.redirect(params.backUrl ? params.backUrl : utils.makeUrl(''));

	} catch(err) {
		return utils.errorPage({req, res}, 'Lỗi kết nối cơ sở dữ liệu.')
	}
});



router.all('/profile', async (req, res) => {
	if (!utils.isLoggedIn({req, res}))
		return utils.errorPage({req, res}, 'Bạn cần đăng nhập để xem trang này.');

	const currentYear = new Date().getFullYear();

	const [prjStructure, globalPlanList, executorList, projectList, chartRows] = await Promise.all([
		project.getProjectStructure(),
		database.query(`select id, name from global_plan where year = ${currentYear} order by name`),
		database.query(`select id, name from division where type=${utils.DIVISION_TYPES.EXECUTION} order by name`),
		database.query(`select id, name from project where year(start_date) <= ${currentYear} and year(end_date) >= ${currentYear} order by name`),
		database.query(`select * from user_chart where user = ${utils.getUserId({req, res})} order by id`)
	]);

	const chartList = chartRows.map(e => {return {
		id: e.id,
		title: e.title,
		type: e.type,
		itemId: e.item,
		globalPlan: e.global_plan,
		project: e.project,
		executor: e.executor
	}});

	res.render('profile', {
		title: `Trang cá nhân: ${res.locals.user.fullName}`,
		prjStructure,
		globalPlanList,
		projectList,
		executorList,
		chartList
	});
});


// ajax
router.all('/user-chart/load-data', async (req, res) => {
	if (!utils.isLoggedIn({req, res}))
		return utils.ajaxError({req, res}, 'Không có quyền.');

	const chartId = req.body.chartId ? parseInt(req.body.chartId) : null;
	if (!chartId) return utils.ajaxError({req, res}, 'Chưa xác định theo dõi cần xoá.');

	const chartInf = await database.queryRow(`select * from user_chart where id = ${chartId} and user = ${utils.getUserId({req, res})}`);
	if (!chartInf) return utils.ajaxError({req, res}, 'Theo dõi không tồn tại.');
	
	const chart = {
		labels: [],
		datasets: [{
				label: 'Kế hoạch',
				data: [],
				borderColor: 'gray',
				lineTension: 0,
				fill: false
			}, {
				label: 'Thực hiện',
				data: [],
				borderColor: 'red',
				lineTension: 0,
				fill: false
			}, {
				label: 'Kiểm tra (KCS)',
				data: [],
				borderColor: 'green',
				lineTension: 0,
				fill: false
			}, {
				label: 'Kiểm tra (KT)',
				data: [],
				borderColor: 'blue',
				lineTension: 0,
				fill: false
		}]
	};

	const dataTypeToDatasetIndex = [];
	dataTypeToDatasetIndex[project.DATA_GROUP_TYPES.KE_HOACH] = 0;
	dataTypeToDatasetIndex[project.DATA_GROUP_TYPES.THUC_HIEN] = 1;
	dataTypeToDatasetIndex[project.DATA_GROUP_TYPES.KIEM_TRA_KCS] = 2;
	dataTypeToDatasetIndex[project.DATA_GROUP_TYPES.KIEM_TRA_KY_THUAT] = 3;

	const sumChildren = await project.getProjectSumChildrenById(chartInf.item);

	if (chartInf.type == project.USER_CHART_TYPES.CURRENT_MONTH) {
		const currentDate = new Date(),
			currentYear = currentDate.getFullYear(),
			currentMonth = currentDate.getMonth() + 1,
			daysInMonth = new Date(currentYear, currentMonth, 0).getDate();

		chart.labels = Array(daysInMonth).fill(0).map((e, i) => `${i+1}/${currentMonth}`);
		chart.datasets.forEach(ds => {
			ds.data = Array(daysInMonth).fill(null);
		});

		const monthPlanValue = await database.queryValue('select sum(value) value_sum from project_data d join project_data_group g on g.id = d.data_group' +
			` where item in (${sumChildren.join(',')})` +
			` and type = ${project.DATA_GROUP_TYPES.KE_HOACH}` +
			` and global_plan = ${chartInf.global_plan}` +
			(chartInf.project ? ` and project = ${chartInf.project}` : '') +
			(chartInf.executor ? ` and division = ${chartInf.executor}` : '') +
			` and check_date = "${currentYear}-${currentMonth}-01"`);
		if (monthPlanValue) {
			chart.datasets[ dataTypeToDatasetIndex[project.DATA_GROUP_TYPES.KE_HOACH] ].data.forEach((e, i, a) => {
				a[i] = Math.round(monthPlanValue / daysInMonth * (i+1) * 100) / 100;
			});
		}
		
		const rows = await database.query('select day(check_date)-1 idx, type, sum(value) value_sum from project_data d join project_data_group g on g.id = d.data_group' +
			` where item in (${sumChildren.join(',')})` +
			` and type != ${project.DATA_GROUP_TYPES.KE_HOACH}` +
			` and global_plan = ${chartInf.global_plan}` +
			(chartInf.project ? ` and project = ${chartInf.project}` : '') +
			(chartInf.executor ? ` and division = ${chartInf.executor}` : '') +
			` and check_date between "${currentYear}-${currentMonth}-01" and "${currentYear}-${currentMonth}-${daysInMonth}"` +
			` group by check_date, type`);
	
		rows.forEach(row => {
			chart.datasets[ dataTypeToDatasetIndex[row.type] ].data[row.idx] = row.value_sum;
		});

	} else if (chartInf.type == project.USER_CHART_TYPES.CURRENT_YEAR) {
		const currentDate = new Date(),
			currentYear = currentDate.getFullYear();

		chart.labels = Array(12).fill(0).map((e, i) => `T${i+1}`);
		chart.datasets.forEach(ds => {
			ds.data = Array(12).fill(null);
		});
	
		const rows = await database.query('select month(check_date)-1 idx, type, sum(value) value_sum from project_data d join project_data_group g on g.id = d.data_group' +
			` where item in (${sumChildren.join(',')})` +
			` and (type != ${project.DATA_GROUP_TYPES.KE_HOACH} or global_plan = ${chartInf.global_plan})` +
			(chartInf.project ? ` and project = ${chartInf.project}` : '') +
			(chartInf.executor ? ` and division = ${chartInf.executor}` : '') +
			` and check_date between "${currentYear}-01-01" and "${currentYear}-12-31"` +
			` group by year(check_date)*12+month(check_date), type`);
	
		rows.forEach(row => {
			chart.datasets[ dataTypeToDatasetIndex[row.type] ].data[row.idx] = row.value_sum;
		});
	}

	utils.ajaxOk({req, res}, { chart });
});


// ajax
router.all('/user-chart/add', async (req, res) => {
	if (!utils.isLoggedIn({req, res}))
		return utils.ajaxError({req, res}, 'Không có quyền.');

	const params = {
		title: req.body.title ? req.body.title.trim() : null,
		type: req.body.type ? parseInt(req.body.type) : null,
		item: req.body.itemId ? parseInt(req.body.itemId) : null,
		globalPlan: req.body.globalPlan ? parseInt(req.body.globalPlan) : null,
		project: req.body.project ? parseInt(req.body.project) : null,
		executor: req.body.executor ? parseInt(req.body.executor) : null,
	};

	if (params.type == null) return utils.ajaxError({req, res}, 'Chưa xác định loại theo dõi.');
	if (params.item == null) return utils.ajaxError({req, res}, 'Chưa xác định mục theo dõi.');
	if (params.globalPlan == null) return utils.ajaxError({req, res}, 'Chưa xác định kế hoạch tham chiếu.');

	const query = 'insert into user_chart set' +
		` user = ${utils.getUserId({req, res})}` +
		`, title = ${params.title ? '"' + params.title + '"' : 'null'}` +
		`, type = ${params.type}` +
		`, item = ${params.item}` +
		`, global_plan = ${params.globalPlan ? params.globalPlan : 'null'}` +
		`, project = ${params.project ? params.project : 'null'}` +
		`, executor = ${params.executor ? params.executor : 'null'}`;
	const rows = await database.query(query);

	utils.ajaxOk({req, res}, {
		id: rows.insertId
	});
});


// ajax
router.all('/user-chart/delete', async (req, res) => {
	if (!utils.isLoggedIn({req, res}))
		return utils.ajaxError({req, res}, 'Không có quyền.');

	const chartId = req.body.chartId ? parseInt(req.body.chartId) : null;
	if (!chartId) return utils.ajaxError({req, res}, 'Chưa xác định theo dõi cần xoá.');

	const row = await database.queryValue(`select id from user_chart where id = ${chartId} and user = ${utils.getUserId({req, res})}`);
	if (!row) return utils.ajaxError({req, res}, 'Theo dõi không tồn tại.');

	await database.query(`delete from user_chart where id = ${chartId}`);

	utils.ajaxOk({req, res});
});



router.all('/admin', (req, res) => {
	res.render('admin', {
		title: 'Quản trị'
	});
});



router.all('/backups', (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_administration')) return;

	const backups = common.enumBackups();
	res.render('backups', {
		title: 'Danh sách bản sao lưu',
		backups
	});
});



router.all('/backups/:id/download', (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_administration')) return;

	if (!req.params.id.match(/^([0-9]{14})$/)) return utils.errorPage({req, res}, 'Tham số sai.');

	const timestamp = moment(req.params.id, 'YYYYMMDDHHmmss');
	return res.download(common.backupFilePath(timestamp));
});



// ajax
router.all('/backups/create', async (req, res) => {
	if (!utils.hasPermission({req, res}, 'perm_administration'))
		return utils.ajaxError({req, res}, 'Không có quyền.');

	await common.createBackup();
	return utils.ajaxOk({req, res}, {});
});



// ajax
router.all('/backups/:id/delete', (req, res) => {
	if (!utils.hasPermission({req, res}, 'perm_administration'))
		return utils.ajaxError({req, res}, 'Không có quyền.');

	if (!req.params.id.match(/^([0-9]{14})$/)) return utils.ajaxError({req, res}, 'Tham số sai.');

	const timestamp = moment(req.params.id, 'YYYYMMDDHHmmss');
	fs.unlink(common.backupFilePath(timestamp), err => {
		if (err) console.error(err);
	});

	return utils.ajaxOk({req, res}, {});
});



// ajax
router.all('/backups/:id/restore', async (req, res) => {
	if (!utils.hasPermission({req, res}, 'perm_administration'))
		return utils.ajaxError({req, res}, 'Không có quyền.');

	if (!req.params.id.match(/^([0-9]{14})$/)) return utils.ajaxError({req, res}, 'Tham số sai.');

	const timestamp = moment(req.params.id, 'YYYYMMDDHHmmss');
	try {
		await common.restoreBackup(timestamp);
	} catch(err) {
		return utils.ajaxError({req, res}, err);
	}

	return utils.ajaxOk({req, res}, {});
});


router.all('/user-groups', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_manage_users')) return;

	const groups = await database.query('select g.*, ' +
		'(select count(*) from user u inner join user_group_assoc ug on ug.user = u.id where ug.user_group = g.id) users ' +
		'from user_group g ' +
		'order by name');
	res.render('user-groups', {
		title: 'Danh sách nhóm tài khoản',
		groups
	});
});




async function addEditUserGroup(req, res, edit) {
	if (!utils.checkPermission({req, res}, 'perm_manage_users')) return;

	if (edit) {
		var groupInfo = await database.queryRow(`select g.* from user_group g where id=${req.params.id}`);
		if (!groupInfo) return utils.errorPage({req, res}, "Nhóm tài khoản không tồn tại.");
	}

	const params = {
		submitted: req.body.submitted == 1,
		name: null,
		description: null,
		perm: utils.USER_PERMISSIONS.map(p => false)
	};

	if (params.submitted) {
		params.name = req.body.name ? req.body.name.trim() : null;
		params.description = req.body.description ? req.body.description.trim() : null;

		for (const p of utils.USER_PERMISSIONS) {
			params.perm[p.name] = req.body[p.name] ? (req.body[p.name] == 'ON') : false;
		}

	} else if (edit) {
		params.name = groupInfo['name'];
		params.description = groupInfo['description'];

		for (const p of utils.USER_PERMISSIONS) {
			params.perm[p.name] = groupInfo[p.name];
		}
	}

	const data = {
		title: `${edit ? 'Sửa' : 'Tạo'} nhóm tài khoản người dùng`,
		edit,
		params,
		errors: []
	};

	if (params.submitted) {
		if (!params.name) data.errors.push('Chưa xác định tên nhóm.');

		const sameName = await database.queryValue(edit ?
			`select count(1) from user_group where name = ${database.escape(params.name)} and id != ${req.params.id}` :
			`select count(1) from user_group where name = ${database.escape(params.name)}`);
		if (sameName > 0) data.errors.push('Tên nhóm đã được sử dụng, hãy chọn tên khác.');
	}

	if (params.submitted && data.errors.length == 0) {
		const query = `${edit ? 'update' : 'insert into'} user_group set ` +
			`name = ${database.escape(params.name)},` +
			`description = ${params.description ? database.escape(params.description) : 'null'},` +
			utils.USER_PERMISSIONS.map(p => `${p.name} = ${params.perm[p.name]}`).join(',') +
			(edit ? ` where id = ${req.params.id}` : '');
		const rows = await database.query(query);

		return res.redirect(utils.makeUrl('/user-group/' + (edit ? req.params.id : rows.insertId)));
	}

	res.render('user-group--add-edit', data);
}


router.all('/user-group/add', (req, res) => addEditUserGroup(req, res, false));
router.all('/user-group/:id/edit', (req, res) => addEditUserGroup(req, res, true));




router.all('/user-group/:id', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_manage_users')) return;

	const group = await database.queryRow(`select g.* from user_group g where g.id = ${req.params.id}`);
	if (!group) return utils.errorPage({req, res}, "Nhóm tài khoản không tồn tại.");

	const users = await utils.queryUserList(`g.id=${req.params.id}`);
	res.render('user-group', {
		title: `Nhóm tài khoản: ${group.name}`,
		group,
		users
	});
});



router.post('/user-group/:id/delete', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_administration')) return;

	const groupId = await database.queryValue(`select id from user_group where id = ${req.params.id}`);
	if (!groupId) return utils.errorPage({req, res}, "Nhóm tài khoản không tồn tại.");

	await database.query(`delete from user_group_assoc where user_group = ${req.params.id}`);
	await database.query(`delete from user_group where id = ${req.params.id}`);
	res.redirect(utils.makeUrl('/user-groups'));
});






router.all('/divisions', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_manage_users')) return;

	const divisionsByType = await Promise.all([utils.DIVISION_TYPES.ADMINISTRATION, utils.DIVISION_TYPES.EXECUTION].map(type => database.query('select d.*, ' +
			'(select count(*) from user u inner join user_division_assoc ud on ud.user = u.id where ud.division = d.id) users ' +
			`from division d where type=${type} ` +
			'order by name')));

	res.render('divisions', {
		title: 'Danh sách phòng ban, bộ phận',
		administrationDivisions: divisionsByType[0],
		excutionDivisions: divisionsByType[1]
	});
});




async function addEditDivision(req, res, edit) {
	if (!utils.checkPermission({req, res}, 'perm_manage_users')) return;

	if (edit) {
		var divisionInfo = await database.queryRow(`select d.* from division d where id=${req.params.id}`);
		if (!divisionInfo) return utils.errorPage({req, res}, "Bộ phận không tồn tại.");
	}

	const params = {
		submitted: req.body.submitted == 1,
		name: null,
		description: null
	};

	if (params.submitted) {
		params.name = req.body.name ? req.body.name.trim() : null;
		params.description = req.body.description ? req.body.description.trim() : null;
		params.type = req.body.type || null;

	} else if (edit) {
		params.name = divisionInfo['name'];
		params.description = divisionInfo['description'];
		params.type = divisionInfo['type'];
	}

	const data = {
		title: `${edit ? 'Sửa' : 'Tạo'} phòng ban, bộ phận`,
		edit,
		params,
		errors: []
	};

	if (params.submitted) {
		if (!params.name) data.errors.push('Chưa xác định tên bộ phận.');

		const sameName = await database.queryValue(edit ?
			`select count(1) from division where name = ${database.escape(params.name)} and id != ${req.params.id}` :
			`select count(1) from division where name = ${database.escape(params.name)}`);
		if (sameName > 0) data.errors.push('Tên bộ phận đã được sử dụng, hãy chọn tên khác.');
	}

	if (params.submitted && data.errors.length == 0) {
		const query = `${edit ? 'update' : 'insert into'} division set ` +
			`name = ${database.escape(params.name)},` +
			`type = ${params.type},` +
			`description = ${params.description ? database.escape(params.description) : 'null'}` +
			(edit ? ` where id = ${req.params.id}` : '');
		const rows = await database.query(query);

		return res.redirect(utils.makeUrl('/division/' + (edit ? req.params.id : rows.insertId)));
	}

	res.render('division--add-edit', data);
}


router.all('/division/add', (req, res) => addEditDivision(req, res, false));
router.all('/division/:id/edit', (req, res) => addEditDivision(req, res, true));






router.all('/division/:id', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_manage_users')) return;

	const row = await database.queryRow('select d.*,' +
		'group_concat(concat(p.id, "|", p.name) order by p.name) projects' +
		' from division d left outer join division_project_assoc dp on dp.division = d.id left outer join project p on dp.project = p.id' +
		` where d.id = ${req.params.id}`);
	if (!row) return utils.errorPage({req, res}, "Bộ phận không tồn tại.");

	const division = {
		...row,
		projects: [] // see below
	};

	// collect projects information
	if (row['projects']) {
		division.projects = row['projects'].split(',').map(p => {
			const [id, name] = p.split('|');
			return {
				id: parseInt(id),
				name
			};
		});
	}

	const userList = await utils.queryUserList(`d.id=${req.params.id}`);

	res.render('division', {
		title: `Bộ phận: ${division.name}`,
		division,
		userList
	});
});




router.post('/division/:id/delete', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_administration')) return;

	const divisionId = await database.queryValue(`select id from division where id = ${req.params.id}`);
	if (!divisionId) return utils.errorPage({req, res}, "Bộ phận không tồn tại.");

	await database.query(`delete from user_division_assoc where division = ${req.params.id}`);
	await database.query(`delete from division where id = ${req.params.id}`);
	res.redirect(utils.makeUrl('/divisions'));
});






router.all('/users', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_manage_users')) return;

	const users = await utils.queryUserList();
	res.render('users', {
		title: 'Danh sách tài khoản',
		users
	});
});





router.all('/user/download', (req, res) => {
	if (!utils.isLoggedIn({req, res}))
		return utils.errorPage({req, res}, 'Không có quyền.');

	res.render('user--download', {
		title: 'Tài nguyên'
	});
});



router.all('/user/help', (req, res) => {
	if (!utils.isLoggedIn({req, res}))
		return utils.errorPage({req, res}, 'Không có quyền.');

	res.render('user--help', {
		title: 'Hướng dẫn sử dụng'
	});
});


router.all('/user/help/download', (req, res) => {
	if (!utils.isLoggedIn({req, res}))
		return utils.errorPage({req, res}, 'Không có quyền.');

	res.download(utils.getDownloadFilePath('user-guide.pdf'));
});



router.all('/user/excel-add-in', (req, res) => {
	if (!utils.isLoggedIn({req, res}))
		return utils.errorPage({req, res}, 'Không có quyền.');

	res.render('user--excel-add-in', {
		title: 'Cài đặt ứng dụng mở rộng trên Excel'
	});
});


router.all('/user/edge-legacy-fix', (req, res) => {
	if (!utils.isLoggedIn({req, res}))
		return utils.errorPage({req, res}, 'Không có quyền.');

	res.render('user--edge-legacy-fix', {
		title: 'Sửa lỗi Edge Legacy'
	});
});


router.all('/user/edge-legacy-fix/download', (req, res) => {
	if (!utils.isLoggedIn({req, res}))
		return utils.errorPage({req, res}, 'Không có quyền.');

	res.download(utils.getDownloadFilePath('edge-legacy-fix.reg'));
});



router.all('/user/excel-add-in/download', async (req, res) => {
	if (!utils.isLoggedIn({req, res}))
		return utils.errorPage({req, res}, 'Không có quyền.');

	let templateContent;
	try {
		templateContent = fs.readFileSync(utils.getDownloadFilePath('excel-add-in-template--manifest.prod.xml')).toString();
	} catch(err) {
		return utils.errorPage({req, res}, 'Không đọc được file mẫu.');
	}

	const withAutologin = (req.query.autologin == 1);
	const loginHash = (withAutologin ? await utils.generateUserLoginHash(utils.getUserId({req, res})) : null);

	const content = templateContent.replace(/\${\s*([A-Za-z0-9_]+)\s*}/g, (match, capture) => {
		const name = capture.trim();

		if (name == 'HOMEPAGE') {
			let url = `${config.webServer.publicAddress}/excel`;
			if (withAutologin) url += `?hash=${loginHash}`;
			else url += `?username=${res.locals.user.login}`;
			return url;
		} else if (name == 'SERVER_ADDRESS') return config.webServer.publicAddress;
		else if (name == 'SERVER_DOMAIN') return (new URL(config.webServer.publicAddress)).origin;
	});

	res.attachment('manifest.prod.xml').send(content);
});



async function addEditUser(req, res, edit) {
	if (!utils.checkPermission({req, res}, 'perm_manage_users')) return;

	if (edit) {
		var userInfo = await database.queryRow('select u.*,' +
			' group_concat(distinct d.id order by d.id) did,' +
			' group_concat(distinct g.id order by g.id) gid' +
			' from user u left outer join user_group_assoc ug on ug.user = u.id left outer join user_group g on g.id = ug.user_group ' +
			' left outer join user_division_assoc ud on ud.user = u.id left outer join division d on d.id = ud.division ' +
			` where u.id = ${req.params.id}` +
			' group by u.id');
		if (!userInfo) return utils.errorPage({req, res}, "Tài khoản không tồn tại.");
	}

	const params = {
		submitted: req.body.submitted == 1,
		username: null,
		fullName: null,
		email: null,
		password: null,
		groups: [],
		divisions: []
	};

	if (params.submitted) {
		params.username = req.body.username ? req.body.username.trim() : null;
		params.fullName = req.body.fullName ? req.body.fullName.trim() : null;
		params.email = req.body.email ? req.body.email.trim() : null;
		params.password = req.body.password;

		if (req.body.divisions) params.divisions = req.body.divisions.map(e => parseInt(e));
		if (req.body.groups) params.groups = req.body.groups.map(e => parseInt(e));

	} else if (edit) {
		params.username = userInfo['login'];
		params.fullName = userInfo['full_name'];
		params.email = userInfo['email'];

		if (userInfo['did']) params.divisions = userInfo['did'].split(',').map(e => parseInt(e));
		if (userInfo['gid']) params.groups = userInfo['gid'].split(',').map(e => parseInt(e));
	}

	const [userGroupList, divisionList] = await Promise.all([
		database.query('select * from user_group order by name'),
		database.query('select * from division order by name')
	]);

	const data = {
		title: `${edit ? 'Sửa' : 'Tạo'} tài khoản người dùng`,
		edit,
		userGroupList,
		divisionList,
		params,
		errors: []
	};

	if (params.submitted) {
		if (!params.username)
			data.errors.push('Chưa xác định tên đăng nhập.');
		else if (!params.username.match(/^[0-9\sa-zA-Z_-]+$/))
			data.errors.push('Tên đăng nhập không hợp lệ.');
		else {
			const sameLogin = await database.queryValue(edit ?
				`select count(1) from user where login = ${database.escape(params.username)} and id != ${req.params.id}` :
				`select count(1) from user where login = ${database.escape(params.username)}`);
			if (sameLogin > 0) data.errors.push('Tên đăng nhập đã được sử dụng.');
		}

		if (!params.fullName) data.errors.push('Chưa nhập họ tên.');

		if (!params.email) data.errors.push('Chưa nhập email.');
		else if (!params.email.match(/^[a-zA-Z0-9.!#$%&’*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/)) data.errors.push('Email không hợp lệ.');

		if (!edit && !params.password) data.errors.push('Chưa nhập mật khẩu.');
		if (params.password && !utils.checkStrongPassword(params.password)) data.errors.push('Mật khẩu chưa đủ mạnh (ít nhất 6 ký tự không dấu).');
	}

	if (params.submitted && data.errors.length == 0) {
		let query = `${edit ? 'update' : 'insert into'} user set ` +
			`login = ${database.escape(params.username)},` +
			`full_name = ${database.escape(params.fullName)},` +
			`email = ${database.escape(params.email)},`;

		if (!edit || params.password) query += `password = sha2(${database.escape(params.password)}, 256),`

		query += 'create_time = now()' +
			(edit ? ` where id=${req.params.id}` : '');

		const rows = await database.query(query);
		const userId = edit ? req.params.id : rows.insertId;

		if (edit) {
			await database.query('delete from user_division_assoc where user = ?', [userId]);
			await database.query('delete from user_group_assoc where user = ?', [userId]);
			if (params.password) await database.query('delete from user_login_hash where user = ?', [userId]);
		}

		await database.query('insert into user_division_assoc(user, division) values' + params.divisions.map(p => `(${userId},${p})`).join(','));
		await database.query('insert into user_group_assoc(user, user_group) values' + params.groups.map(p => `(${userId},${p})`).join(','));

		return res.redirect(utils.makeUrl('/user/' + userId));
	}

	res.render('user--add-edit', data);
}


router.all('/user/add', async (req, res) => addEditUser(req, res, false));
router.all('/user/:id/edit', async (req, res) => addEditUser(req, res, true));



router.all('/user/:id/change-password', async (req, res) => {
	if (!utils.isLoggedIn({req, res}))
		return utils.errorPage({req, res}, 'Bạn cần đăng nhập để xem trang này.');

	const params = {
		submitted: req.body.submitted == 1,
		oldPassword: null,
		newPassword: null,
		newPassword2: null,
		errors: []
	};

	if (params.submitted) {
		params.oldPassword = req.body.oldPassword;
		params.newPassword = req.body.password;
		params.newPassword2 = req.body.password2;
	}

	const data = {
		title: 'Đổi mật khẩu',
		errors: []
	};

	const userId = utils.getUserId({req, res});

	if (params.submitted) {
		const checkOldPwd = await database.queryValue(`select 1 from user where id = ${userId} and password = sha2(${database.escape(params.oldPassword)}, 256)`);
		if (!checkOldPwd) data.errors.push('Mật khẩu cũ không đúng.');
		else if (params.newPassword == null) data.errors.push('Chưa nhập mật khẩu mới.');
		else if (params.newPassword2 == null) data.errors.push('Chưa nhập lại mật khẩu mới lần hai.');
		else if (params.newPassword !== params.newPassword2) data.errors.push('Hai lần nhập mật khẩu mới không giống nhau.');
		else if (params.newPassword == params.oldPassword) data.errors.push('Mật khẩu mới không được giống mật khẩu cũ.');
		else if (!utils.checkStrongPassword(params.newPassword)) data.errors.push('Mật khẩu mới chưa đủ mạnh (ít nhất 6 ký tự không dấu).');
	}

	if (params.submitted && data.errors.length == 0) {
		const query = `update user set password = sha2(${database.escape(params.newPassword)}, 256) where id = ${userId}`;
		await database.query(query);
		await database.query('delete from user_login_hash where user = ?', [userId]);
		return utils.noticePage({req, res}, 'Đổi mật khẩu', 'Đã đổi mật khẩu thành công.');
	}

	res.render('user--change-password', data);
})



router.all('/user/:id', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_manage_users')) return;

	const row = await database.queryRow('select u.*,' +
			' group_concat(distinct concat(d.id, "|", d.name) order by d.id) divisions,' +
			' group_concat(distinct concat(g.id, "|", g.name) order by g.id) user_groups,' +
			utils.USER_PERMISSIONS.map(p => `max(g.${p.name}) ${p.name}`).join(',') +
			' from user u left outer join user_group_assoc ug on ug.user = u.id left outer join user_group g on g.id = ug.user_group ' +
			' left outer join user_division_assoc ud on ud.user = u.id left outer join division d on d.id = ud.division ' +
			` where u.id=${req.params.id}` +
			' group by u.id');
	if (!row) return utils.errorPage({req, res}, "Tài khoản không tồn tại.");


	const theUser = {
		...row,
		divisions: [],	// see below
		groups: [],	// see below
		perm: []	// see below
	};

	// collect divisions information
	if (row['divisions']) {
		theUser.divisions = row['divisions'].split(',').map(d => {
			const [id, name] = d.split('|');
			return {
				id: parseInt(id),
				name
			};
		});
	}

	// collect user groups information
	if (row['user_groups']) {
		theUser.groups = row['user_groups'].split(',').map(d => {
			const [id, name] = d.split('|');
			return {
				id: parseInt(id),
				name
			};
		});
	}

	// collect user permissions
	for (const p of utils.USER_PERMISSIONS) {
		theUser.perm[p.name] = row['perm_administration'] || row[p.name];
	}

	res.render('user', {
		title: `Tài khoản: ${theUser.login}`,
		theUser
	});
});



router.all('/user/:id/deactivate', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_manage_users')) return;

	if (req.params.id == config.rootUserId) return utils.errorPage({req, res}, 'Không được phép khoá tài khoản root.');

	const row = await database.queryRow(`select deactivate_time from user where id = ${req.params.id}`);
	if (!row) return utils.errorPage({req, res}, 'Tài khoản không tồn tại.');

	if (row.deactivate_time) return utils.errorPage({req, res}, `Tài khoản đã khoá từ ${row.deactivate_time}.`);

	await database.query(`update user set deactivate_time = now() where id = ${req.params.id}`);
	res.redirect(utils.makeUrl(`/user/${req.params.id}`));
});


router.all('/user/:id/reactivate', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_manage_users')) return;

	const row = await database.queryRow(`select deactivate_time from user where id = ${req.params.id}`);
	if (!row) return utils.errorPage({req, res}, 'Tài khoản không tồn tại.');

	if (!row.deactivate_time) return utils.errorPage({req, res}, 'Tài khoản chưa bị khoá.');

	await database.query(`update user set deactivate_time = null where id = ${req.params.id}`);
	res.redirect(utils.makeUrl(`/user/${req.params.id}`));
});



router.all('/global-plans', async (req, res) => {
	if (!utils.checkAnyPermission({req, res}, ['perm_manage_users', 'perm_ke_hoach', 'perm_ky_thuat', 'perm_vat_tu', 'perm_ke_toan', 'perm_kcs', 'perm_phan_xuong'])) return;

	const plans = await database.query('select * from global_plan order by year desc');
	res.render('global-plans', {
		title: 'Danh sách kế hoạch',
		list: plans
	});
});



async function addEditGlobalPlan(req, res, edit) {
	if (!utils.checkPermission({req, res}, 'perm_ky_thuat')) return;

	if (edit) {
		var planInfo = await database.queryRow(`select * from global_plan where id = ${req.params.id}`);
		if (!planInfo) return utils.errorPage({req, res}, "Kế hoạch không tồn tại.");
	}

	const params = {
		submitted: req.body.submitted == 1,
		name: null,
		description: null,
		year: null,
		duplicateFrom: req.body.duplicateFrom == 'ON',
		duplicateFromPlan: null
	};

	if (params.submitted) {
		params.name = req.body.name ? req.body.name.trim() : null;
		params.description = req.body.description ? req.body.description.trim() : null;
		params.year = parseInt(req.body.year);
		params.duplicateFromPlan = parseInt(req.body.duplicateFromPlan);

	} else if (edit) {
		params.name = planInfo['name'];
		params.description = planInfo['description'];
		params.year = planInfo['year'];
	} else {
		params.year = new Date().getFullYear();
	}

	const data = {
		title: edit ? `Sửa kế hoạch: ${params.name}` : 'Tạo kế hoạch',
		edit,
		params,
		errors: []
	};

	if (!edit) {
		data.globalPlans = await database.query('select * from global_plan order by year desc, name');
	}

	if (params.submitted) {
		if (!params.name)
			data.errors.push('Chưa xác định tên kế hoạch.');
		else {
			const sameName = await database.queryValue(edit ?
				`select count(1) from global_plan where name = ${database.escape(params.name)} and id != ${req.params.id}` :
				`select count(1) from global_plan where name = ${database.escape(params.name)}`);
			if (sameName > 0) data.errors.push('Tên kế hoạch đã được sử dụng, hãy chọn tên khác.');
		}

		if (params.year < 2000 && params.year > 2100)
			data.errors.push('Năm không hợp lệ.');
	}

	if (params.submitted && data.errors.length == 0) {
		let query = `${edit ? 'update' : 'insert into'} global_plan set` +
			` name = ${database.escape(params.name)}` +
			`,description = ${params.description ? database.escape(params.description) : 'null'}` +
			`,year = ${params.year}`;

		if (!edit) {
			query += `,creator = ${res.locals.user.id}` +
				',create_time = now()';
		} else {
			query += ` where id=${req.params.id}`;
		}

		const rows = await database.query(query);
		const planId = edit ? req.params.id : rows.insertId;

		if (params.duplicateFrom) {
			const dataGroups = await database.query(`select * from project_data_group where global_plan = ${params.duplicateFromPlan}`);
			await Promise.all(dataGroups.map(e => async () => {
				const checkDate = moment(e.check_date);
				const dataGroupInsertRows = await database.query('insert into project_data_group set' +
					` project = ${e.project}` +
					`, check_date = "${params.year}-${checkDate.month()+1}-${checkDate.days()+1}"` +
					', update_time = now()' +
					`, type = ${e.type}` +
					`, division = ${e.division}` +
					`, global_plan = ${planId}`);
				await database.query('insert into project_data(item,value,data_group) ' +
					`select item,value,${dataGroupInsertRows.insertId} from project_data where data_group = ${e.id}`);
			}));
		}

		return res.redirect(utils.makeUrl('/global-plan/' + planId));
	}

	res.render('global-plan--add-edit', data);
}


router.all('/global-plan/add', async (req, res) => addEditGlobalPlan(req, res, false));
router.all('/global-plan/:id/edit', async (req, res) => addEditGlobalPlan(req, res, true));



router.all('/global-plan/:id/delete', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_administration')) return;

	const planId = await database.queryValue(`select id from global_plan where id = ${req.params.id}`);
	if (!planId) return utils.errorPage({req, res}, "Kế hoạch không tồn tại.");

	await database.query(`delete from project_data where data_group in (select id from project_data_group where global_plan = ${req.params.id})`);
	await database.query(`delete from project_data_group where global_plan = ${req.params.id}`);
	await database.query(`delete from global_plan where id = ${req.params.id}`);
	res.redirect(utils.makeUrl('/global-plans'));
});



function generateYearGlobalPlanColumns(year, monthly) {
	if (monthly) {
		return [
			{
				title: 'Kế hoạch',
				name: 'value0'
			}, {
				title: 'Thực hiện',
				name: 'value1'
			}, {
				title: 'Kiểm tra (KT)',
				name: 'value2'
			}, {
				title: 'Kiểm tra (KCS)',
				name: 'value3'
			}
		];
	}

	const columns = [{
		title: `Kế hoạch (${year})`,
		name: 'value0'
	}, {
		title: `Thực hiện (${year})`,
		name: 'value1'
	}];

	for (let m = 1, i = 2; m <= 12; m++, i+=2) {
		columns.push({
			title: `Kế hoạch (${m}/${year})`,
			name: `value${i}`
		});

		columns.push({
			title: `Thực hiện (${m}/${year})`,
			name: `value${i+1}`
		});
	}

	return columns;
}

async function globalPlanRouteHandler(req, res, monthly) {
	if (!utils.checkAnyPermission({req, res}, ['perm_manage_users', 'perm_ke_hoach', 'perm_ky_thuat', 'perm_vat_tu', 'perm_ke_toan', 'perm_kcs', 'perm_phan_xuong'])) return;

	const rowPlan = await database.queryRow('select p.*, u.id uid, u.full_name uname' +
			' from global_plan p inner join user u on p.creator = u.id' +
			` where p.id=${req.params.globalPlanId}`);
	if (!rowPlan) return utils.errorPage({req, res}, "Kế hoạch không tồn tại.");

	const projects = await database.query(`select id, name from project where year(start_date) <= ${rowPlan['year']} and year(end_date) >= ${rowPlan['year']} order by name`);

	const plan = {
		...rowPlan,
		projects
	};

	res.render('global-plan', {
		title: `Kế hoạch: ${plan.name}`,
		plan,
		monthly,

		// sheet data:
		dataType: project.DATA_GROUP_TYPES.KE_HOACH,
		columns: generateYearGlobalPlanColumns(rowPlan['year'], monthly),
		monthDate: true,
		loadUrl: utils.makeUrl(`/global-plan/${req.params.globalPlanId}/load-data` + (monthly ? '/monthly' : '')),
		sheetReadonly: true,
		sheetStaticData: !monthly,
		sheetInitialDate: new Date(rowPlan['year'], 0, 1),
		sheetStartDate: new Date(rowPlan['year'], 0, 1),
		sheetEndDate: new Date(rowPlan['year'], 11, 31)
	});
}


router.all('/global-plan/:globalPlanId', async (req, res) => globalPlanRouteHandler(req, res, false));
router.all('/global-plan/:globalPlanId/monthly', async (req, res) => globalPlanRouteHandler(req, res, true));




async function globalPlanProjectRouteHandler(req, res, monthly) {
	if (!utils.checkPermission({req, res}, 'perm_ky_thuat')) return;

	const rowPrj = await database.queryRow(`select id, name, finish_time from project where id = ${req.params.projectId}`);
	if (!rowPrj) return utils.errorPage({req, res}, 'Công trình không tồn tại.');
	if (rowPrj.finish_time) return utils.errorPage({req, res}, 'Công trình đã hoàn thành.');

	const rowPlan = await database.queryRow(`select * from global_plan where id = ${req.params.globalPlanId}`);
	if (!rowPlan) return utils.errorPage({req, res}, 'Kế hoạch không tồn tại.');

	const divisions = await database.query(`select d.* from division d join division_project_assoc a on a.division = d.id where a.project=${req.params.projectId} order by name`);

	res.render('project--ke-hoach', {
		title: `Kế hoạch công trình: ${rowPlan.name} » ${rowPrj.name}`,
		projectId: req.params.projectId,
		globalPlan: rowPlan,
		divisions,
		monthly,

		// sheet data:
		dataType: project.DATA_GROUP_TYPES.KE_HOACH,
		columns: generateYearGlobalPlanColumns(rowPlan['year'], monthly),
		monthDate: true,
		loadUrl: utils.makeUrl(`/global-plan/${req.params.globalPlanId}/project/${req.params.projectId}/load-data` + (monthly ? '/monthly' : '')),
		sheetReadonly: true,
		sheetStaticData: !monthly,
		sheetInitialDate: new Date(rowPlan['year'], 0, 1),
		sheetStartDate: new Date(rowPlan['year'], 0, 1),
		sheetEndDate: new Date(rowPlan['year'], 11, 31)
	});
}

router.all('/global-plan/:globalPlanId/project/:projectId', async (req, res) => globalPlanProjectRouteHandler(req, res, false));
router.all('/global-plan/:globalPlanId/project/:projectId/monthly', async (req, res) => globalPlanProjectRouteHandler(req, res, true));





router.all('/projects/structure', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_ky_thuat')) return;

	const structure = await project.getProjectStructure();

	res.render('projects-structure', {
		title: 'Cấu trúc công trình',
		data: structure,

		// sheet data
		columns: [{
			title: 'Giá trị',
			name: 'value_type'
		}]
	});
});


// ajax
router.post('/projects/structure/save', async (req, res) => {
	if (!utils.hasPermission({req, res}, 'perm_ky_thuat'))
		return utils.ajaxError({req, res}, 'Không có quyền.');
	
	const structure = req.body.structure;
	if (!structure) return utils.ajaxError({req, res}, 'Không có dữ liệu.');

	await project.saveProjectStructure(structure);

	utils.ajaxOk({req, res});
});



router.all('/reports', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_ky_thuat')) return;

	const reports = await database.query('select r.*, u.full_name cname from report r inner join user u on r.creator = u.id order by create_time desc');
	res.render('reports', {
		title: 'Danh sách báo cáo',
		reports
	});
});



router.all('/report/export', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_ky_thuat')) return;

	const globalPlans = await database.query('select * from global_plan order by year desc, name');

	res.render('report--export', {
		title: 'Xuất báo cáo',
		globalPlans
	});
});



// ajax
router.post('/report/export/save', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_ky_thuat')) return;

	if (!req.body.startDate) return utils.ajaxError({req, res}, 'Chưa xác định thời gian bắt đầu.');
	if (!req.body.endDate) return utils.ajaxError({req, res}, 'Chưa xác định thời gian kết thúc.');

	const startDate = moment(req.body.startDate, 'MM/YYYY'),
		endDate = moment(req.body.endDate, 'MM/YYYY');
	if (endDate.isBefore(startDate)) return utils.ajaxError({req, res}, 'Tháng kết thúc được chọn sớm hơn tháng bắt đầu.');

	const reportType = parseInt(req.body.reportType);
	if (Object.values(project.REPORT_TYPES).indexOf(reportType) == -1) return utils.ajaxError({req, res}, 'Chưa xác định loại báo cáo.');

	let title, filename, reportGroups = [];
	
	if (reportType == project.REPORT_TYPES.THEO_DOI) {
		title = `Tổng hợp chỉ tiêu K.T - K.T toàn mỏ ${startDate.format('MM/YYYY')} - ${endDate.format('MM/YYYY')}`;
		filename = `bao-cao-theo-doi-${startDate.format('YYYY-MM')}-${endDate.format('YYYY-MM')}`;

		const exDivisions = await database.query(`select id, name from division where type = ${utils.DIVISION_TYPES.EXECUTION}`);
		const firstDate = startDate.toDate();
		const lastDate = moment(endDate).add(1, 'M').subtract(1, 'd').toDate();

		reportGroups.push({
			title: 'Tổng khối lượng',
			startDate: firstDate,
			endDate: lastDate,
			dataType: project.DATA_GROUP_TYPES.THUC_HIEN
		});

		exDivisions.forEach(d => {
			reportGroups.push({
				title: d.name,
				startDate: firstDate,
				endDate: lastDate,
				dataType: project.DATA_GROUP_TYPES.THUC_HIEN,
				divisionIds: [d.id]
			});
		});

	} else if (reportType == project.REPORT_TYPES.TONG_HOP) {
		title = `Báo cáo thực hiện các chỉ tiêu KTCN ${startDate.format('MM/YYYY')} - ${endDate.format('MM/YYYY')}`;
		filename = `bao-cao-tong-hop-${startDate.format('YYYY-MM')}-${endDate.format('YYYY-MM')}`;

		reportGroups.push({
			title: 'Tổng kế hoạch',
			startDate: startDate.toDate(),
			endDate: moment(endDate).add(1, 'M').subtract(1, 'd').toDate(),
			dataType: project.DATA_GROUP_TYPES.KE_HOACH,
			globalPlanId: req.body.globalPlan
		});

		for (let d = moment(startDate); !d.isAfter(endDate); d.add(1, 'M')) {
			const firstDate = moment(d).toDate();
			const lastDate = moment(d).add(1, 'M').subtract(1, 'd').toDate();

			reportGroups.push({
				title: `KH tháng ${d.format('MM/YYYY')}`,
				startDate: firstDate,
				endDate: lastDate,
				dataType: project.DATA_GROUP_TYPES.KE_HOACH,
				globalPlanId: req.body.globalPlan
			});
			
			reportGroups.push({
				title: `TH tháng ${d.format('MM/YYYY')}`,
				startDate: firstDate,
				endDate: lastDate,
				dataType: project.DATA_GROUP_TYPES.THUC_HIEN
			});
		}
	}

	filename += `-${moment().format('YYYYMMDDHHmmSS')}.xlsx`;

	const data = await project.loadProjectReportData(null, reportGroups);

	await project.writeReport2File(title, project.getReportFilePath(filename), reportGroups.map(e => e.title), data, reportType);

	const rows = await database.query(`insert into report set title = ${database.escape(title)},` +
			`description = ${req.body.description ? database.escape(req.body.description) : 'null'},` +
			`filename = "${filename}",` +
			`creator = ${res.locals.user.id}`);

	utils.ajaxOk({req, res}, {url: utils.makeUrl(`/report/${rows.insertId}/download`)});
});


router.get('/report/:id/download', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_ky_thuat')) return;

	const filename = await database.queryValue(`select filename from report where id = ${req.params.id}`);
	if (!filename) return utils.errorPage({req, res}, "Báo cáo không tồn tại.");

	const path = project.getReportFilePath(filename);
	if (!fs.existsSync(path)) return utils.errorPage({req, res}, "File báo cáo không tồn tại.");

	res.download(path);
});


// ajax
router.post('/report/:id/delete', async (req, res) => {
	if (!utils.hasPermission({req, res}, 'perm_administration')) return utils.ajaxError({req, res}, "Không có quyền.");

	const filename = await database.queryValue(`select filename from report where id = ${req.params.id}`);
	if (!filename) return utils.ajaxError({req, res}, "Báo cáo không tồn tại.");

	database.query(`delete from report where id = ${req.params.id}`);
	fs.unlink(project.getReportFilePath(filename), err => {
		if (err && config.debug) console.error(err);
	});

	utils.ajaxOk({req, res});
});





router.all('/projects', async (req, res) => {
	if (!utils.checkAnyPermission({req, res}, ['perm_ky_thuat', 'perm_ke_hoach', 'perm_vat_tu', 'perm_ke_toan', 'perm_kcs', 'perm_phan_xuong'])) return;

	const onlyPhanXuong = !utils.hasAnyPermission({req, res}, ['perm_ky_thuat', 'perm_ke_hoach', 'perm_vat_tu', 'perm_ke_toan', 'perm_kcs']);

	const projects = !onlyPhanXuong ? await database.query('select *, year(end_date) year from project order by (end_date is not null), end_date desc') :
		await database.query('select distinct p.*, year(p.end_date) year from project p join division_project_assoc dpa on dpa.project = p.id ' +
			'join user_division_assoc uda on uda.division = dpa.division where uda.user = ? ' +
			'order by (p.end_date is not null), p.end_date desc', [utils.getUserId({req, res})]);

	res.render('projects', {
		title: 'Danh mục công trình',
		projects
	});
});





async function addEditProject(req, res, edit) {
	if (!utils.checkPermission({req, res}, 'perm_ky_thuat')) return;

	if (edit) {
		var projectInfo = await database.queryRow('select p.*, u.id uid, u.full_name uname,group_concat(d.id order by d.name) did' +
			' from project p inner join user u on p.creator = u.id' +
			' left outer join division_project_assoc dp on dp.project = p.id left outer join division d on dp.division = d.id' +
			` where p.id = ${req.params.id}`);
		if (!projectInfo) return utils.errorPage({req, res}, "Công trình không tồn tại.");
	}

	const params = {
		submitted: req.body.submitted == 1,
		name: null,
		description: null,
		start_date: null,
		end_date: null,
		executors: []
	};

	const executorList = await database.query(`select * from division where type=${utils.DIVISION_TYPES.EXECUTION} order by name`);

	if (params.submitted) {
		params.name = req.body.name ? req.body.name.trim() : null;
		params.description = req.body.description ? req.body.description.trim() : null;
		params.start_date = req.body.start_date ? moment(req.body.start_date, config.dateFormat.moment) : null;
		params.end_date = req.body.end_date ? moment(req.body.end_date, config.dateFormat.moment) : null;

		if (req.body.executors) params.executors = req.body.executors.map(e => parseInt(e));

	} else if (edit) {
		params.name = projectInfo['name'];
		params.description = projectInfo['description'];
		params.start_date = projectInfo['start_date'] ? moment(projectInfo['start_date']) : null;
		params.end_date = projectInfo['end_date'] ? moment(projectInfo['end_date']) : null;

		if (projectInfo['did']) params.executors = projectInfo['did'].split(',').map(e => parseInt(e));
	}

	const data = {
		title: edit ? `Sửa công trình: ${params.name}` : 'Tạo công trình',
		edit,
		params,
		executorList,
		errors: []
	};

	if (params.submitted) {
		if (!params.name)
			data.errors.push('Chưa xác định tên công trình.');
		else {
			const sameName = await database.queryValue(edit ?
				`select count(1) from project where name = ${database.escape(params.name)} and id != ${req.params.id}` :
				`select count(1) from project where name = ${database.escape(params.name)}`);
			if (sameName > 0) data.errors.push('Tên công trình đã được sử dụng, hãy chọn tên khác.');
		}

		if (params.end_date && params.end_date.isBefore(params.start_date)) data.errors.push('Ngày kết thúc được chọn sớm hơn ngày bắt đầu.');

		if (params.executors.length == 0)
			data.errors.push('Chưa chọn phân xưởng thực hiện.')
	}

	if (params.submitted && data.errors.length == 0) {
		let query = `${edit ? 'update' : 'insert into'} project set` +
			` name = ${database.escape(params.name)}` +
			`,description = ${params.description ? database.escape(params.description) : 'null'}` +
			`,start_date = ${params.start_date ? '"' + database.toSqlDate(params.start_date.toDate()) + '"' : 'null'}` +
			`,end_date = ${params.end_date ? '"' + database.toSqlDate(params.end_date.toDate()) + '"' : 'null'}`;

		if (!edit) {
			query += `,creator = ${res.locals.user.id}` +
				',create_time = now()';
		} else {
			query += ` where id=${req.params.id}`;
		}

		const rows = await database.query(query);
		const projectId = edit ? req.params.id : rows.insertId;

		await database.query('delete from division_project_assoc where project=' + projectId);
		await database.query('insert into division_project_assoc(division, project) values' + params.executors.map(p => `(${p},${projectId})`).join(','));

		return res.redirect(utils.makeUrl('/project/' + (edit ? req.params.id : rows.insertId)));
	}

	res.render('project--add-edit', data);
}


router.all('/project/add', async (req, res) => addEditProject(req, res, false));
router.all('/project/:id/edit', async (req, res) => addEditProject(req, res, true));



router.all('/project/:projectId', async (req, res) => {
	if (!utils.checkAnyPermission({req, res}, ['perm_ky_thuat', 'perm_ke_hoach', 'perm_vat_tu', 'perm_ke_toan', 'perm_kcs', 'perm_phan_xuong'])) return;

	const row = await database.queryRow('select p.*, u.id uid, u.full_name uname,' +
			`group_concat(concat(d.id, "|", d.name, "|", exists(select 1 from user_division_assoc dma where dma.user = ${res.locals.user.id} and dma.division = d.id))) divisions` +
			' from project p inner join user u on p.creator = u.id' +
			' left outer join division_project_assoc dp on dp.project = p.id left outer join division d on dp.division = d.id' +
			` where p.id=${req.params.projectId}`);
	if (!row) return utils.errorPage({req, res}, "Công trình không tồn tại.");

	const dateConstraints = [];
	if (row['start_date']) dateConstraints.push(`year >= ${moment(row['start_date'], 'YYYY-MM-DD').year()}`);
	if (row['end_date']) dateConstraints.push(`year <= ${moment(row['end_date'], 'YYYY-MM-DD').year()}`);
	const globalPlans = await database.query('select * from global_plan where ' + dateConstraints.join(' and ') + ' order by year desc, name');

	const project = {
		...row,
		executors: [], //see below
		globalPlans
	};

	// collect execution divisions information
	if (row['divisions']) {
		project.executors = row['divisions'].split(',').map(d => {
			const [id, name, isProjectMember] = d.split('|');
			return {
				id: parseInt(id),
				name,
				isProjectMember: isProjectMember == '1'
			};
		});
	}

	res.render('project', {
		title: `Công trình: ${project.name}`,
		project
	});
});






router.all('/project/:id/close', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_ky_thuat')) return;

	const row = await database.queryRow(`select finish_time from project where id = ${req.params.id}`);
	if (!row) return utils.errorPage({req, res}, 'Công trình không tồn tại.');

	if (row.finish_time) return utils.errorPage({req, res}, `Công trình đã hoàn thành từ ${row.finish_time}.`);

	await database.query(`update project set finish_time = now() where id = ${req.params.id}`);
	res.redirect(utils.makeUrl(`/project/${req.params.id}`));
});


router.all('/project/:id/reopen', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_ky_thuat')) return;

	const row = await database.queryRow(`select finish_time from project where id = ${req.params.id}`);
	if (!row) return utils.errorPage({req, res}, 'Công trình không tồn tại.');

	if (!row.finish_time) return utils.errorPage({req, res}, 'Công trình vẫn đang mở.');

	await database.query(`update project set finish_time = null where id = ${req.params.id}`);
	res.redirect(utils.makeUrl(`/project/${req.params.id}`));
});




router.all('/project/:projectId/ke-hoach/:globalPlanId/:divisionId', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_ky_thuat')) return;

	const rowPrj = await database.queryRow(`select id, name, finish_time from project where id = ${req.params.projectId}`);
	if (!rowPrj) return utils.errorPage({req, res}, 'Công trình không tồn tại.');
	if (rowPrj.finish_time) return utils.errorPage({req, res}, 'Công trình đã hoàn thành.');

	const rowDiv = await database.queryRow(`select id, name from division where id = ${req.params.divisionId}`);
	if (!rowDiv) return utils.errorPage({req, res}, 'Đơn vị không tồn tại.');

	res.render('project--data-input', {
		title: `Kế hoạch công trình: ${rowPrj.name} - ${rowDiv.name}`,
		projectId: req.params.projectId,

		// sheet data:
		dataType: project.DATA_GROUP_TYPES.KE_HOACH,
		columns: [{
			title: 'Khối lượng',
			name: 'value'
		}],
		monthDate: true,
		loadUrl: utils.makeUrl(`/project/${req.params.projectId}/load-data/ke-hoach/${req.params.globalPlanId}/${req.params.divisionId}`),
		saveUrl: utils.makeUrl(`/project/${req.params.projectId}/save-data/ke-hoach/${req.params.globalPlanId}/${req.params.divisionId}`),
		sheetReadonly: false,
		sheetStaticData: false
	});
});


router.all('/project/:projectId/kiem-tra-kt', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_ky_thuat')) return;

	const row = await database.queryRow(`select id, name, finish_time from project where id = ${req.params.projectId}`);
	if (!row) return utils.errorPage({req, res}, 'Công trình không tồn tại.');
	if (row.finish_time) return utils.errorPage({req, res}, 'Công trình đã hoàn thành.');

	res.render('project--data-input', {
		title: `Báo cáo kiểm tra kỹ thuật công trình: ${row.name}`,
		projectId: req.params.projectId,

		// sheet data:
		dataType: project.DATA_GROUP_TYPES.KIEM_TRA_KY_THUAT,
		columns: [{
			title: 'Khối lượng',
			name: 'value'
		}],
		monthDate: false,
		loadUrl: utils.makeUrl(`/project/${req.params.projectId}/load-data/kiem-tra-kt`),
		saveUrl: utils.makeUrl(`/project/${req.params.projectId}/save-data/kiem-tra-kt`),
		sheetReadonly: false,
		sheetStaticData: false
	});
});


router.all('/project/:projectId/kiem-tra-kcs', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_kcs')) return;

	const row = await database.queryRow(`select id, name, finish_time from project where id = ${req.params.projectId}`);
	if (!row) return utils.errorPage({req, res}, 'Công trình không tồn tại.');
	if (row.finish_time) return utils.errorPage({req, res}, 'Công trình đã hoàn thành.');

	res.render('project--data-input', {
		title: `Báo cáo kiểm tra chất lượng công trình: ${row.name}`,
		projectId: req.params.projectId,

		// sheet data:
		dataType: project.DATA_GROUP_TYPES.KIEM_TRA_KCS,
		columns: [{
			title: 'Khối lượng',
			name: 'value'
		}],
		monthDate: false,
		loadUrl: utils.makeUrl(`/project/${req.params.projectId}/load-data/kiem-tra-kcs`),
		saveUrl: utils.makeUrl(`/project/${req.params.projectId}/save-data/kiem-tra-kcs`),
		sheetReadonly: false,
		sheetStaticData: false
	});
});


router.all('/project/:projectId/thuc-hien/:divisionId', async (req, res) => {
	if (!utils.checkPermission({req, res}, 'perm_phan_xuong')) return;

	const row = await database.queryRow(`select id, name, finish_time from project where id = ${req.params.projectId}`);
	if (!row) return utils.errorPage({req, res}, 'Công trình không tồn tại.');
	if (row.finish_time) return utils.errorPage({req, res}, 'Công trình đã hoàn thành.');

	const divisionName = await database.queryValue(`select name from division where id = ${req.params.divisionId}`);

	res.render('project--data-input', {
		title: `Báo cáo thực hiện công trình: ${row.name} (${divisionName})`,
		projectId: req.params.projectId,

		// sheet data:
		dataType: project.DATA_GROUP_TYPES.THUC_HIEN,
		columns: [{
			title: 'Khối lượng',
			name: 'value'
		}],
		monthDate: false,
		loadUrl: utils.makeUrl(`/project/${req.params.projectId}/load-data/thuc-hien/${req.params.divisionId}`),
		saveUrl: utils.makeUrl(`/project/${req.params.projectId}/save-data/thuc-hien/${req.params.divisionId}`),
		sheetReadonly: false,
		sheetStaticData: false
	});
});



async function generateYearGlobalPlanDataGroups(req, res, monthly) {
	if (monthly) {
		const month = moment(req.body.date, 'MM/YYYY'),
			startDate = month.toDate(),
			endDate = moment(month).add(1, 'M').subtract(1, 'd').toDate();
		return [{
				startDate,
				endDate,
				dataType: project.DATA_GROUP_TYPES.KE_HOACH,
				globalPlanId: req.params.globalPlanId
			}, {
				startDate,
				endDate,
				dataType: project.DATA_GROUP_TYPES.THUC_HIEN
			}, {
				startDate,
				endDate,
				dataType: project.DATA_GROUP_TYPES.KIEM_TRA_KY_THUAT
			}, {
				startDate,
				endDate,
				dataType: project.DATA_GROUP_TYPES.KIEM_TRA_KCS
			}
		];
	}

	const year = await database.queryValue(`select year from global_plan where id=${req.params.globalPlanId}`);

	const dataGroups = [{
			startDate: new Date(year, 0, 1),
			endDate: new Date(year, 11, 31),
			dataType: project.DATA_GROUP_TYPES.KE_HOACH,
			globalPlanId: req.params.globalPlanId
		}, {
			startDate: new Date(year, 0, 1),
			endDate: new Date(year, 11, 31),
			dataType: project.DATA_GROUP_TYPES.THUC_HIEN
		}
	];

	for (let m = 0; m <= 11; m++) {
		dataGroups.push({
			startDate: new Date(year, m, 1),
			endDate: new Date(year, m + 1, 0),
			dataType: project.DATA_GROUP_TYPES.KE_HOACH,
			globalPlanId: req.params.globalPlanId
		});
		
		dataGroups.push({
			startDate: new Date(year, m, 1),
			endDate: new Date(year, m + 1, 0),
			dataType: project.DATA_GROUP_TYPES.THUC_HIEN
		});
	}

	return dataGroups;
}

async function globalPlanLoadDataRouteHandler(req, res, monthly) {
	if (!utils.hasPermission({req, res}, 'perm_ky_thuat'))
		return utils.ajaxError({req, res}, 'Không có quyền.');

	const dataGroups = await generateYearGlobalPlanDataGroups(req, res, monthly);

	const data = await project.loadProjectReportData(null, dataGroups);

	for (const e of data) {
		for (let i = 0; i < e.value.length; i++) e[`value${i}`] = e.value[i];
		delete e.value;
	}

	utils.ajaxOk({req, res}, data);
}


// ajax
router.post('/global-plan/:globalPlanId/load-data', async (req, res) => globalPlanLoadDataRouteHandler(req, res, false));
router.post('/global-plan/:globalPlanId/load-data/monthly', async (req, res) => globalPlanLoadDataRouteHandler(req, res, true));



async function globalPlanProjectLoadDataRouteHandler(req, res, monthly) {
	if (!utils.hasPermission({req, res}, 'perm_ky_thuat'))
		return utils.ajaxError({req, res}, 'Không có quyền.');

	const dataGroups = await generateYearGlobalPlanDataGroups(req, res, monthly);

	const data = await project.loadProjectReportData(req.params.projectId, dataGroups);

	for (const e of data) {
		for (let i = 1; i < 26; i++) e[`value${i}`] = e.value[i];
		delete e.value;
	}
	
	utils.ajaxOk({req, res}, data);
}

// ajax
router.post('/global-plan/:globalPlanId/project/:projectId/load-data', async (req, res) => globalPlanProjectLoadDataRouteHandler(req, res, false));
router.post('/global-plan/:globalPlanId/project/:projectId/load-data/monthly', async (req, res) => globalPlanProjectLoadDataRouteHandler(req, res, true));


// ajax
router.post('/project/:projectId/load-data/ke-hoach/:globalPlanId/:divisionId', async (req, res) => {
	if (!utils.hasPermission({req, res}, 'perm_ky_thuat'))
		return utils.ajaxError({req, res}, 'Không có quyền.');

	const data = await project.loadProjectData(req.params.projectId, project.DATA_GROUP_TYPES.KE_HOACH, moment(req.body.date, 'MM/YYYY').toDate(), req.params.divisionId, req.params.globalPlanId);
	utils.ajaxOk({req, res}, data);
});

// ajax
router.post('/project/:projectId/save-data/ke-hoach/:globalPlanId/:divisionId', async (req, res) => {
	if (!utils.hasPermission({req, res}, 'perm_ky_thuat'))
		return utils.ajaxError({req, res}, 'Không có quyền.');

	const data = req.body.data;
	if (!data) return utils.ajaxError({req, res}, 'Không có dữ liệu.');

	await project.updateProjectData(req.params.projectId, project.DATA_GROUP_TYPES.KE_HOACH, moment(req.body.date, 'MM/YYYY').toDate(), req.params.divisionId, req.params.globalPlanId, data);
	utils.ajaxOk({req, res});
});



// ajax
router.post('/project/:projectId/load-data/kiem-tra-kt', async (req, res) => {
	if (!utils.hasPermission({req, res}, 'perm_ky_thuat'))
		return utils.ajaxError({req, res}, 'Không có quyền.');

	const data = await project.loadProjectData(req.params.projectId, project.DATA_GROUP_TYPES.KIEM_TRA_KY_THUAT, moment(req.body.date, 'DD/MM/YYYY').toDate(), null, null);
	utils.ajaxOk({req, res}, data);
});

// ajax
router.post('/project/:projectId/save-data/kiem-tra-kt', async (req, res) => {
	if (!utils.hasPermission({req, res}, 'perm_ky_thuat'))
		return utils.ajaxError({req, res}, 'Không có quyền.');

	const data = req.body.data;
	if (!data) return utils.ajaxError({req, res}, 'Không có dữ liệu.');

	await project.updateProjectData(req.params.projectId, project.DATA_GROUP_TYPES.KIEM_TRA_KY_THUAT, moment(req.body.date, 'DD/MM/YYYY').toDate(), null, null, data);
	utils.ajaxOk({req, res});
});



// ajax
router.post('/project/:projectId/load-data/kiem-tra-kcs', async (req, res) => {
	if (!utils.hasPermission({req, res}, 'perm_kcs'))
		return utils.ajaxError({req, res}, 'Không có quyền.');

	const data = await project.loadProjectData(req.params.projectId, project.DATA_GROUP_TYPES.KIEM_TRA_KCS, moment(req.body.date, 'DD/MM/YYYY').toDate(), null, null);
	utils.ajaxOk({req, res}, data);
});

// ajax
router.post('/project/:projectId/save-data/kiem-tra-kcs', async (req, res) => {
	if (!utils.hasPermission({req, res}, 'perm_kcs'))
		return utils.ajaxError({req, res}, 'Không có quyền.');

	const data = req.body.data;
	if (!data) return utils.ajaxError({req, res}, 'Không có dữ liệu.');

	await project.updateProjectData(req.params.projectId, project.DATA_GROUP_TYPES.KIEM_TRA_KCS, moment(req.body.date, 'DD/MM/YYYY').toDate(), null, null, data);
	utils.ajaxOk({req, res});
});



// ajax
router.post('/project/:projectId/load-data/thuc-hien/:divisionId', async (req, res) => {
	if (!utils.hasPermission({req, res}, 'perm_phan_xuong'))
		return utils.ajaxError({req, res}, 'Không có quyền.');

	const data = await project.loadProjectData(req.params.projectId, project.DATA_GROUP_TYPES.THUC_HIEN, moment(req.body.date, 'DD/MM/YYYY').toDate(), req.params.divisionId, null);
	utils.ajaxOk({req, res}, data);
});

// ajax
router.post('/project/:projectId/save-data/thuc-hien/:divisionId', async (req, res) => {
	if (!utils.hasPermission({req, res}, 'perm_phan_xuong'))
		return utils.ajaxError({req, res}, 'Không có quyền.');

	const data = req.body.data;
	if (!data) return utils.ajaxError({req, res}, 'Không có dữ liệu.');

	await project.updateProjectData(req.params.projectId, project.DATA_GROUP_TYPES.THUC_HIEN, moment(req.body.date, 'DD/MM/YYYY').toDate(), req.params.divisionId, null, data);
	utils.ajaxOk({req, res});
});





module.exports = router;
