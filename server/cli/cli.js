const readline = require("readline");
const common = require("../common/common");




const commandArray = [];


function addCommand(name, desc, callback) {
    name.toLowerCase();
    if (commandArray[name] != undefined)
        console.log(`Command already exists: ${name}`);
    else commandArray[name] = {
        desc: desc,
        callback: callback
    };
}

function findCommandByName(name) {
    name.toLowerCase();
    return commandArray[name] != undefined ? commandArray[name] : null;
}

async function execCommand(name, args) {
    name.toLowerCase();
    if (commandArray[name] == undefined) throw new Error("Invalid command");
    return commandArray[name].callback(args);
}

function printCommandList() {
    for (let name in commandArray) {
        console.log(`${name}: ${commandArray[name].desc}`);
    }
}

function initCLI() {
    addCommand("backup", "Create a backup", args => {
        common.createBackup();
        return true;
    });

    addCommand("restore", "Restore a backup", args => {
        common.restoreBackup(args[0]);
        return true;
    });
    
    addCommand("exit", "Shutdown server", args => {
        common.shutdown();
        return false;
    });
    
    addCommand("help", "Show this help", args => {
        printCommandList();
        return true;
    });
    
    
    
    
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    rl.on('line', (cmd) => {
        cmd = cmd.trim();
        if (cmd) {
            const args = cmd.split(/\s+/);
            const cmdName = args[0].toLowerCase();
            args.splice(0, 1);
    
            execCommand(cmdName, args)
                .then(ret => {
                    rl.prompt("> ");
                })
                .catch(err => {
                    console.log(err.toString());
                    rl.prompt("> ");
                });
    
        } else {
            rl.prompt("> ");
        }
    
    }).on('close', () => {
        common.shutdown();
    });
    
    
    console.log("CLI started!");
    rl.prompt("> ");
}


module.exports = {
    addCommand: addCommand,
    findCommandByName: findCommandByName,
    execCommand: execCommand,
    printCommandList: printCommandList,
    initCLI: initCLI
}

