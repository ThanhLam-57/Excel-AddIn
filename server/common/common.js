const mysqldump = require('mysqldump');
const moment = require('moment');
const fs = require('fs');
const child_process = require('child_process');
const crypto = require('crypto');
const gunzip = require('gunzip-file');
const mysqlImporter = require('mysql-import');

const config = require('../common/config');
const web = require('../web/public');




/////////////////////////////////////////////////////////////////////////////////////////////

let underMaintenance = false;


function isUnderMaintenance() {
    return underMaintenance;
}

function createFolderStructure() {
    fs.mkdirSync('dist/data/backup', { recursive: true });
    fs.mkdirSync('dist/data/report', { recursive: true });
}


function backupFilePath(timestamp) {
    return `dist/data/backup/database-${timestamp.format('YYYYMMDD.HHmmss')}.sql.gz`;
}



function enumBackups() {
	const regex = new RegExp('database-([0-9]{8}).([0-9]{6}).sql.gz');

	const files = fs.readdirSync('dist/data/backup').reduce((accu, e) => {
		const m = e.match(regex);
		if (m) {
			accu.push({
				filename: e,
				timestamp: moment(`${m[1]}${m[2]}`, 'YYYYMMDDHHmmss'),
                id: `${m[1]}${m[2]}`
			});
		}

		return accu;
	}, []).sort((a, b) => b.id.localeCompare(a.id));

	return files;
}


function createBackup() {
    return new Promise((resolve, reject) => {
        if (underMaintenance) return reject('Hệ thống đang bảo trì.');
        underMaintenance = true;
    
        mysqldump({
            connection: {
                host: config.database.host,
                user: config.database.username,
                password: config.database.password,
                database: config.database.schema,
            },
            dumpToFile: backupFilePath(moment()),
            compressFile: true,
            dump: {
                schema: {
                    table: {
                        dropIfExist: true
                    }
                }
            }
        }).then(resolve)
        .catch(reject);

    }).finally(() => {
        underMaintenance = false;
    });
}


function restoreBackup(timestamp) {
    return new Promise((resolve, reject) => {
        if (underMaintenance) return reject('Hệ thống đang bảo trì.');
        underMaintenance = true;

        const zipFile = backupFilePath(moment(timestamp, 'YYYYMMDDHHmmss'));
        if (!fs.existsSync(zipFile)) return reject('File không tồn tại.');

        const tmpSqlFile = 'dist/tmp/backup.sql';
        gunzip(zipFile, tmpSqlFile, async () => {
            const importer = new mysqlImporter({
                host: config.database.host,
                user: config.database.username,
                password: config.database.password,
                database: config.database.schema
            });

            await importer.import(tmpSqlFile);

            fs.unlink(tmpSqlFile, err => {
                if (err && config.debug) console.error(err);
            });

            resolve(importer.getImported() > 0);
        });
        
    }).finally(() => {
        underMaintenance = false;
    });
}


function shutdown() {
	if (web.serverHttp) web.serverHttp.close();
    if (web.serverHttps) web.serverHttps.close();
	console.log('Have a great day!');
	process.exit(0);
}


function checkSoftwareLicence() {
    return true;
    
    const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqMEqbY/zCWpoLgqlGUeg
eF+qz5dtjOktWQxMH4Uxx/dm9fCwJl/66NqNUyqF6a0A+h0eLdSDHlC4RwTsNohC
jmynnon/g0Ki38nUkZxUKjP48XdGOGxZqLiYIgZtY7AO+zX8LuIElA7yczi0zixa
wgExOS4PoAhD/t+p7s80SI87bmeOjwUSN5zX7zIDwxecN4lt33x79KpRpsb/995I
mJ1mNW0feSmrA9RLDEw/eTGA5/bwnGhNUAD46pnVLX/j1ieiq+EmjP5ARzVXIjHq
C/o15+HZ8MJ+7EVvCNGrWjoXU2y23jkT9Z8TY7mDfBgPtow888HnvRcBqEEe7+sR
fQIDAQAB
-----END PUBLIC KEY-----`;

    const onError = (msg) => {
        console.log('Licence is not valid.');
        process.exit(0);
    }

    const randomCode = crypto.randomUUID();

    let cmd;
    if (process.platform == 'win32')
        cmd = `dist\\bin\\klmosvc.exe ${randomCode}`;
    else if (process.platform == 'linux')
        cmd = `dist/bin/klmosvc ${randomCode}`;
    else return onError('Phần mềm chưa hỗ trợ hệ điều hành của bạn.');

    child_process.exec(cmd, (err, stdout, stderr) => {
        if (err) return onError('Licence is not valid.');

        const encryptedData = Buffer.from(stdout, 'base64');
        if (!encryptedData) return onError('Licence is not valid.');

        const key = crypto.createPublicKey({
            key: PUBLIC_KEY,
            format: 'pem'
        })

        const decryptedData = crypto.publicDecrypt({
            key,
            padding: crypto.constants.RSA_PKCS1_PADDING
        }, encryptedData);

        const output = decryptedData.toString();
        const outputComps = output.split(':');
        if (outputComps.length != 2 || outputComps[0].localeCompare(randomCode) != 0 || outputComps[1] != 'OK')
            return onError('Licence is not valid.');
    });
}


module.exports = {
    isUnderMaintenance,
    createFolderStructure,
    backupFilePath,
    enumBackups,
	createBackup,
    restoreBackup,
	shutdown,
    checkSoftwareLicence
};

