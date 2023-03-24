const express = require('express');
const config = require('../../common/config');
const database = require('../../common/database');
const utils = require('../utils');
const project = require('../project');
const moment = require('moment');
const fs = require('fs');

const router = express.Router();


router.get('/', async (req, res) => {
    if (!utils.isLoggedIn({req, res}) && req.query.hash) await utils.loginByHash({req, res}, req.query.hash);

    res.render('excel/index', {
        username: req.query.username,
        layout: 'excel/layout'
    })
});

// ajax
router.get('/session-status', (req, res) => {
    utils.ajaxOk({req, res}, {
        isLoggedIn: utils.isLoggedIn({req, res})
    });
});


// ajax
router.post('/pull/general-info', async (req, res) => {
	if (!utils.isLoggedIn({req, res}))
    	return utils.ajaxError({req, res}, 'Bạn chưa đăng nhập.');

    const data = {}

    if (req.body.projectStructure)
        data['projectStructure'] = await project.getProjectStructure(req.body.type);

    if (req.body.globalPlans)
        data['globalPlans'] = await database.query('select id, name, year from global_plan');

    const listAll = utils.hasAnyPermission({req, res}, ['perm_administration', 'perm_ky_thuat', 'perm_kcs', 'perm_ke_hoach']);
    if (req.body.divisions || req.body.projects) {
        const where = listAll ? '1' : `uda.user = ${utils.getUserId({req, res})}`;
        data['divisions'] = await database.query(`select distinct d.id, d.name from division d inner join user_division_assoc uda on uda.division = d.id where ${where} order by d.name`);
    }

    if (req.body.projects) {
        const where = listAll ? '1' : `dpa.division in (${data['divisions'].map(e => e.id).join(',')})`;
        data['projects'] = await database.query(`select distinct p.id, p.name, p.start_date, p.end_date from project p inner join division_project_assoc dpa on dpa.project = p.id where ${where} order by p.name`);
    }

    utils.ajaxOk({req, res}, data);
});


// ajax
router.post('/commit/structure', async (req, res) => {
	if (!utils.hasPermission({req, res}, 'perm_ky_thuat'))
		return utils.ajaxError({req, res}, 'Không có quyền.');

	const structure = req.body.structure;
	if (!structure) return utils.ajaxError({req, res}, 'Không có dữ liệu.');

	const retData = await project.saveProjectStructure(structure);

    utils.ajaxOk({req, res}, retData);
});


// ajax
router.post('/pull/data', async (req, res) => {
	if (!utils.isLoggedIn({req, res}))
		return utils.ajaxError({req, res}, 'Bạn chưa đăng nhập.');

    const retInfo = [];
    const jobs = [];
    for (let i = 0; i < req.body.colsInfo.length; i++) {
        const col = req.body.colsInfo[i];

        const retInfoCol = {
            colIdx: col.colIdx,
            status: true,
            data: null
        };

        if ((col.dataType == project.DATA_GROUP_TYPES.KE_HOACH && !utils.hasPermission({req, res}, 'perm_ky_thuat'))
            || (col.dataType == project.DATA_GROUP_TYPES.THUC_HIEN && !utils.hasPermission({req, res}, 'perm_phan_xuong'))
            || (col.dataType == project.DATA_GROUP_TYPES.KIEM_TRA_KY_THUAT && !utils.hasPermission({req, res}, 'perm_ky_thuat'))
            || (col.dataType == project.DATA_GROUP_TYPES.KIEM_TRA_KCS && !utils.hasPermission({req, res}, 'perm_kcs'))) {
                retInfoCol.status = false;
        } else {
            if (col.isSynthetic) {
                jobs.push(project.loadProjectReportData(col.project, [{
                        dataType: col.dataType,
                        globalPlanId: col.globalPlan,
                        divisionIds: col.division,
                        startDate: moment(col.beginDate, 'YYYYMMDD').toDate(),
                        endDate: moment(col.endDate, 'YYYYMMDD').toDate()
                    }]).then(data => {
                        data.forEach(r => r.value = r.value[0]);
                        retInfoCol.data = data;
                    }));
            } else {
                jobs.push(project.loadProjectData(col.project, col.dataType, moment(col.date, 'YYYYMMDD').toDate(), col.division, col.globalPlan)
                    .then(data => retInfoCol.data = data));
            }
        }

        retInfo.push(retInfoCol);
    }

    await Promise.all(jobs);
    utils.ajaxOk({req, res}, retInfo);
});


// ajax
router.post('/commit/data', async (req, res) => {
	if (!utils.isLoggedIn({req, res}))
		return utils.ajaxError({req, res}, 'Bạn chưa đăng nhập.');

    const retInfo = [];
    for (let i = 0; i < req.body.colsData.length; i++) {
        const col = req.body.colsData[i];

        const retInfoCol = {
            colIdx: col.colIdx,
            status: true
        };

        if ((col.dataType == project.DATA_GROUP_TYPES.KE_HOACH && !utils.hasPermission({req, res}, 'perm_ky_thuat'))
            || (col.dataType == project.DATA_GROUP_TYPES.THUC_HIEN && !utils.hasPermission({req, res}, 'perm_phan_xuong'))
            || (col.dataType == project.DATA_GROUP_TYPES.KIEM_TRA_KY_THUAT && !utils.hasPermission({req, res}, 'perm_ky_thuat'))
            || (col.dataType == project.DATA_GROUP_TYPES.KIEM_TRA_KCS && !utils.hasPermission({req, res}, 'perm_kcs'))) {
                retInfoCol.status = false;
        } else {
            await project.updateProjectData(col.project, col.dataType, moment(col.date, 'YYYYMMDD').toDate(), col.division, col.globalPlan, col.data);
        }

        retInfo.push(retInfoCol);
    }

    utils.ajaxOk({req, res}, retInfo);
});



module.exports = router;
