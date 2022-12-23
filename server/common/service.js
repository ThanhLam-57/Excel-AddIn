const common = require('./common');
const config = require('../common/config');
const cron = require('cron');
const fs = require('fs');


function deepCombineConfigObjects(defaultObj, customObj) {
	for (const [key, value] of Object.entries(customObj)) {
		if (typeof value === 'object' && !Array.isArray(value) && value !== null)
			deepCombineConfigObjects(defaultObj[key], value);
		else defaultObj[key] = value;
	}
}



try {
	const rawCustomConfig = fs.readFileSync('dist/custom-config.json');
	const customConfig = JSON.parse(rawCustomConfig);
	
	deepCombineConfigObjects(config, customConfig);

} catch(err) {
}



common.createFolderStructure();

const backupJob = new cron.CronJob(config.backupCronSchedule, common.createBackup);
backupJob.start();

const licenceJob = new cron.CronJob('0 * * * * *', common.checkSoftwareLicence);
licenceJob.start();
