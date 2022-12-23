const fs = require('fs');
const NodeOptimizer = require('./lib/node-optimize');
const JSObfuscator = require('javascript-obfuscator');
const UglifyJS = require('./lib/terser.min.js');

const optimizer = new NodeOptimizer({
	ignore: [ ],
	include: []
});

const mergedJs = optimizer.merge('main.js');
console.log('Code merging done!');

const obfuscationResult = JSObfuscator.obfuscate(mergedJs, {
	compact: true,
	controlFlowFlattening: true,
	controlFlowFlatteningThreshold: 1,
	numbersToExpressions: true,
	simplify: true,
	shuffleStringArray: true,
	splitStrings: true,
	stringArrayThreshold: 1
});

console.log('Code obfuscation done!');


UglifyJS.minify(obfuscationResult.getObfuscatedCode()).then(minifiedJs => {
	console.log('Code minification done!');

	const path = require('path').resolve('dist/main.dist.js');
	fs.writeFileSync(path, minifiedJs.code);
	
	console.log(`Distribution code saved to: ${path}`);

}).catch(error => {
	console.log(error);
	process.exit();
});


function copyFileIgnoreError(src, dest) {
	try {
		fs.copyFileSync(src, dest);
	} catch(err) {
	}
}


copyFileIgnoreError('../DongleChecker/Release/klmosvc.exe', 'dist/bin/klmosvc.exe');
copyFileIgnoreError('../DongleChecker/Release/SDX.dll', 'dist/bin/SDX.dll');
copyFileIgnoreError('../DongleChecker/Linux/klmosvc', 'dist/bin/klmosvc');