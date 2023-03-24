const config = require('../common/config');
const database = require('../common/database');
const moment = require('moment');
var xl = require('excel4node');
const fs = require('fs');


const DATA_ITEM_VALUE_TYPE = {
	USER_INPUT:	"Dữ liệu nhập".normalize("NFC"),
	SUM_VERT:	"Tổng cột".normalize("NFC"),
	SUM_HORZ:	"Tổng hàng".normalize("NFC"),
	IGNORE:		"Ẩn dữ liệu".normalize("NFC")
};

const DATA_GROUP_TYPES = {
	KE_HOACH:			1,
	THUC_HIEN:			2,
	KIEM_TRA_KCS:		3,
	KIEM_TRA_KY_THUAT:	4,
	KE_HOACH_CHI_TIEU: 5,
	THUC_HIEN_CHI_TIEU: 6,
	KIEM_TRA_CHI_TIEU: 7
};

const REPORT_TYPES = {
	TONG_HOP:		1,
	THEO_DOI:		2
};

const USER_CHART_TYPES = {
	CURRENT_MONTH:	1,
	CURRENT_YEAR:	2
}


async function getUserDivisionsForProject(userId, projectId) {
	const did = await database.queryColumn('select d.id from division d inner join division_project_assoc dpa on d.id = dpa.division' +
		' inner join user_division_assoc uda on d.id = uda.division' +
		` where uda.user = ${userId} and dpa.project = ${projectId}`);
	return did;
}


let prjStructure = null;
let prjStructureIdMap = null;
let prjSumChildrenMap = null;


async function reloadProjectStructure(type = 0) {
	try {
		console.log("Lam");
		let where = ``;
		if(type != 0){
			where = ` WHERE id >= 51 AND id < 137 `;
		}
		prjStructure = await database.query(`select id, name, unit, value_type, level, removed, currency from project_structure_item ${where} order by position`);
		console.log(prjStructure);
		prjStructureIdMap = new Map();
		prjStructure.forEach(e => {
			prjStructureIdMap.set(parseInt(e.id), e);
		});

		buildSumChildrenMap();

	} catch(err) {
		prjStructure = null;
		prjStructureIdMap = null;
		prjSumChildrenMap = null;
	}
}

async function getProjectStructure(type = 0) {
	//if (!prjStructure) 
	await reloadProjectStructure(type);
	return prjStructure;
}


async function saveProjectStructure(newStructure) {
	const newRowsInfo = [];
	const idsInUse = [];

	for (let i = 0; i < newStructure.length; i++) {
		const row = newStructure[i];

		let query = `${row.id ? 'update' : 'insert into'} project_structure_item set name=?, unit=?, value_type=?, level=?, position=?, removed=false`;
		if (row.id) query += ` where id = ${row.id}`;
		const res = await database.query(query, [row.name, row.unit, row.value_type, +row.level, i]);

		if (!row.id) {
			newRowsInfo.push({
				idx: i,
				id: res.insertId
			});

			idsInUse.push(res.insertId);

		} else idsInUse.push(row.id);
	}

	const res = await database.query(`update project_structure_item set removed=true where id not in(${idsInUse.join()})`);
	const removedRows = res.changedRows;

	await reloadProjectStructure();

	return {
		removedRows,
		newRowsInfo
	};
}


function enumSumChildren(idx) {
	const children = [];
	const masterLevel = parseInt(prjStructure[idx].level);

	for (let i = idx + 1; i < prjStructure.length; i++) {
		const e = prjStructure[i];

		const currentLevel = parseInt(e.level);
		if (currentLevel <= masterLevel) break;

		if (e.value_type == DATA_ITEM_VALUE_TYPE.USER_INPUT)
			children.push(parseInt(e.id));
	}

	return children;
}

function buildSumChildrenMap() {
	prjSumChildrenMap = new Map;

	for (let i = 0; i < prjStructure.length; i++) {
		const e = prjStructure[i];
		if (e.removed) continue;

		let children = [];
		if (prjStructure[i].value_type == DATA_ITEM_VALUE_TYPE.SUM_VERT) {
			children = enumSumChildren(i);
		} else {
			children.push(parseInt(e.id));
		}

		prjSumChildrenMap.set(parseInt(prjStructure[i].id), children);
	}
}

async function getProjectSumChildrenById(id) {
	await getProjectStructure();
	return prjSumChildrenMap.get(id);
}



// projectId, divisionId, globalPlanId may be null
async function loadProjectData(projectId, type, date, divisionId, globalPlanId) {
	if (projectId) {
		const row = await database.queryRow(`select id from project where id = ${projectId}`);
		if (!row) throw 'Công trình không tồn tại.';
	}

	const structure = await getProjectStructure();
	let data = JSON.parse(JSON.stringify(structure));	// clone

	const query = 'select id from project_data_group where'
				+ ` type = ${type} and check_date = "${database.toSqlDate(date)}"`
				+ (projectId ? ` and project = ${projectId}` : '')
				+ (divisionId ? ` and division = ${divisionId}` : '')
				+ (globalPlanId ? ` and global_plan = ${globalPlanId}` : '');
	const dataGroupIds = await database.queryColumn(query);
	if (dataGroupIds.length == 0) return data;

	const map = new Map();
	data.forEach(e => {
		map.set(+e.id, e);
	});

	const rows = await database.query(`select item, sum(value) value from project_data where data_group in (${dataGroupIds.join(',')}) group by item`);

	data.forEach(item => item.value = null);

	rows.forEach(r => {
		const mitem = map.get(r.item);
		if (mitem) mitem.value = r['value'];
	});

	return data;
}


// globalPlanId may be null
async function updateProjectData(projectId, type, date, divisionId, globalPlanId, data) {
	const row = await database.queryRow(`select id, finish_time from project where id = ${projectId}`);
	if (!row) throw 'Công trình không tồn tại.';
	if (row.finish_time) throw 'Công trình đã hoàn thành.';

	let dataGroupId = await database.queryValue('select id from project_data_group where'
								+ ` project = ${projectId} and type = ${type} and check_date = "${database.toSqlDate(date)}"`
								+ ' and division ' + (divisionId ? `= ${divisionId}` : 'is null')
								+ (globalPlanId ? ` and global_plan = ${globalPlanId}` : ''));

	if (dataGroupId) {
		const ids = data.map(e => e.id).filter(e => e);	// list of non-null IDs
		if (ids.length > 0) await database.query(`delete from project_data where data_group = ${dataGroupId} and item in (${ids.join(',')})`);
	} else {
		const res = await database.query(`insert into project_data_group set project = ${projectId},` +
			`type = ${type},` +
			`division = ${divisionId},` +
			(globalPlanId ? `global_plan = ${globalPlanId},` : '') +
			`check_date = "${database.toSqlDate(date)}",` +
			`update_time = now()`);
		dataGroupId = res.insertId;
	}

	const valueGroups = data.flatMap(e => {
		return (typeof e.value == 'number' && e.value != 0) ? [`(${e.id}, ${e.value}, ${dataGroupId})`] : [];
	});

	if (valueGroups.length > 0)
		await database.query(`insert into project_data(item, value, data_group) values` + valueGroups.join(','));
}


// groups: [{dataType, globalPlanId?, divisionIds[]?, startDate, endDate}]
async function loadProjectReportData(projectIds, groups) {
	const structure = await getProjectStructure();
	let data = JSON.parse(JSON.stringify(structure));

	const map = new Map();
	data.forEach(e => {
		map.set(parseInt(e.id), e);
		e.value = Array(groups.length).fill(e.value);
	});
	
	let projectIdSql;
	if (!projectIds) projectIdSql = '';
	else if (projectIds instanceof Array) projectIdSql = `and g.project in (${projectIds.join(',')})`;
	else projectIdSql = `and g.project = ${projectIds}`;

	await Promise.all(groups.map(async (g, gi) => {
		const query = 'select item, sum(value) value_total from project_data d join project_data_group g on g.id = d.data_group where' +
				` g.check_date between "${database.toSqlDate(g.startDate)}" and "${database.toSqlDate(g.endDate)}" ` +
				projectIdSql +
				` and g.type = ${g.dataType}` +
				(g.globalPlanId ? ` and g.global_plan = ${g.globalPlanId}` : '') +
				(g.divisionIds ? ` and g.division ${g.divisionIds instanceof Array ? `in (${g.divisionIds.join(',')})` : `= ${g.divisionIds}`}` : '') +
				` group by type, item`;
		const rows = await database.query(query);

		rows.forEach(r => {
			const mitem = map.get(r.item);
			if (mitem) mitem.value[gi] = r['value_total'];
		});
	}));

	return data;
}



function addProjectData(data, newCols, colNames) {
	const cols = newCols[0].length;

	for (let i = 0; i < data.length; i++) {
		const e = data[i];
		for (let j = 0; j < cols; j++) {
			e[colNames[j]] = (typeof e.value === 'string' && e.value.normalize('NFC') != DATA_ITEM_VALUE_TYPE.USER_INPUT ? e.value : newCols[i][j]);
		}
	}
}



/*

function getDataGroupTypeName(t) {
	switch (t) {
	case DATA_GROUP_TYPES.KE_HOACH:				return 'Kế hoạch';
	case DATA_GROUP_TYPES.THUC_HIEN:			return 'Thực hiện';
	case DATA_GROUP_TYPES.KIEM_TRA_KCS:			return 'Kiểm tra KCS';
	case DATA_GROUP_TYPES.KIEM_TRA_KY_THUAT:	return 'Kiểm tra Kỹ thuật';
	}

	return null;
}


function generateReportGroups(types, periods, startDate, endDate) {
	const startYear = startDate.getFullYear(),
		endYear = endDate.getFullYear(),
		startMonth = startDate.getMonth(),
		endMonth = endDate.getMonth();

	let monthList = [];
	if (startYear == endYear) {
		for (let i = startMonth; i < endMonth; i++) monthList.push({ m: i, y: startYear});

	} else {
		for (let i = startMonth; i <= 11; i++) monthList.push({ m: i, y: startYear});

		for (let i = startYear + 1; i <= endYear - 1; i++) {
			for (let j = 0; j <= 11; j++) monthList.push({ m: j, y: i});
		}

		for (let i = 0; i <= endMonth; i++) monthList.push({ m: i, y: endYear});
	}

	let groups = [];

	types.forEach(type => {
		const typeName = getDataGroupTypeName(type);

		let currentYear = -1, currentHaft = -1, currentQuarter = -1;
		for (let i = 0; i < monthList.length; i++) {
			const m = monthList[i],
				haft = Math.floor(m.m / 6),
				quarter = Math.floor(m.m / 3);

			if (periods.year && currentYear != m.y) {
				groups.push({
					title: `${typeName} (Năm ${m.y})`,
					type,
					startDate: new Date(m.y, m.m, 1),
					endDate: new Date(m.y, 11, 31)
				});

				currentYear = m.y;
			}

			if (periods.half && currentHaft != haft) {
				groups.push({
					title: `${typeName} (6 tháng ${haft == 0 ? 'đầu' : 'cuối'} năm ${m.y})`,
					type,
					startDate: new Date(m.y, haft*6, 1),
					endDate: new Date(m.y, (haft+1)*6, -1)
				});

				currentHaft = haft;
			}

			if (periods.quarter && currentQuarter != quarter) {
				const quarter2Roman = ['I','II','III','IV'];
				groups.push({
					title: `${typeName} (Quý ${quarter2Roman[quarter]} năm ${m.y})`,
					type,
					startDate: new Date(m.y, quarter*3, 1),
					endDate: new Date(m.y, (quarter+1)*3, -1)
				});

				currentQuarter = quarter;
			}

			if (periods.month) {
				groups.push({
					title: `${typeName} (Tháng ${m.m+1})`,
					type,
					startDate: new Date(m.y, m.m, 1),
					endDate: new Date(m.y, m.m+1, -1)
				});
			}
		}
	});

	return groups;
} */


function getReportFilePath(filename) {
	return `dist/data/report/${filename}`;
}


async function writeReport2File(title, filename, columns, data, docType) {

//	let data = await project.loadSampleData();
	// Create a new instance of a Workbook class
	var wb = new xl.Workbook();
	
	// Add Worksheets to the workbook
	var ws = wb.addWorksheet('Sheet 1');
	
	// set style and data of table
	writeWorksheet(wb, ws, title, columns, data, docType, filename);

	

}



// =================================================SAMPLE DATA=======================================
const sampleDataFilePath = "./web/data/data.json";
let sampleData = null;
async function loadSampleData(){
	if (sampleData) return sampleData;

	try {
		let content = fs.readFileSync(sampleDataFilePath);

		sampleData = JSON.parse(content);
		
		return sampleData.obj;

	} catch(err) {
		return null;
	}
}


// =================================================Export Formatting=======================================

function setColumnStyle(ws, col, rowCount,  colCount, docType ){
	let width = 0;
	ws.cell(2,col,rowCount,col,false)
	.style({border: {right:{style:'thin', color: "#000000"}}})
	switch (col) {
    case 1:
	  if (docType == REPORT_TYPES.THEO_DOI) width = 4.44;
	  if (docType == REPORT_TYPES.TONG_HOP) width = 2.0;
      ws.column(col).setWidth(width);
      break;
    case 2:
	  if (docType == REPORT_TYPES.THEO_DOI) width = 27;
	  if (docType == REPORT_TYPES.TONG_HOP) width = 45;
      ws.column(col).setWidth(width);
      break;
	case 4:
		if (docType == REPORT_TYPES.THEO_DOI) width = 8.22;
		if (docType == REPORT_TYPES.TONG_HOP) width = 10.89;
		ws.column(col).setWidth(width);
		break;
    default:
		if (docType == REPORT_TYPES.THEO_DOI) width = 7.89;
		if (docType == REPORT_TYPES.TONG_HOP) width = 10.22;
		ws.column(col).setWidth(width);
		break;
  }
}

function setRowStyle(ws, row, rowCount, colCount, docType) {
  let height = 0;

  // document without formal title
  if (docType == REPORT_TYPES.THEO_DOI) {

    switch (row) {
      case 1:
        height = 12.75;
        ws.row(row).setHeight(height);
        ws.cell(row, 1, row, colCount, false).style({
          border: { bottom: { style: "thick", color: "#000000" } }
        });
        break;
      case 3:
        height = 24;
        ws.row(row).setHeight(height);

        ws.cell(row, 1, row, colCount, false).style({
          border: { bottom: { style: "thin", color: "#000000" } }
        });
        break;
      case rowCount:
        ws.cell(row, 1, row, colCount, false).style({
          border: { bottom: { style: "thick", color: "#000000" } }
        });
      default:
        height = 12;
        ws.row(row).setHeight(height);
        break;
    }
  }
  else if(docType == REPORT_TYPES.TONG_HOP) {
	switch (row) {
		case 5:
			height = 21;
			ws.row(row).setHeight(height);
			break;

		case 7:
			height = 15.75;
			ws.row(row).setHeight(height);
			ws.cell(row, 1, row, colCount, false).style({
				border: { top: { style: "thick", color: "#000000" } }
			  });
			break;
		
		case 9:
			height = 48;
			ws.row(row).setHeight(height);
			ws.cell(row, 1, row, colCount, false).style({
				border: { bottom: { style: "thin", color: "#000000" } }
			  });
			break;
		
		case rowCount:
			ws.cell(row, 1, row, colCount, false).style({
				border: { bottom: { style: "thick", color: "#000000" } }
			});
		
		default:
			height = 15.75;
			ws.row(row).setHeight(height);
	}
  }
}

function setTableOutline(ws,baseStyle, title, columns, colCount,docType){
	if (docType == REPORT_TYPES.TONG_HOP){
		ws.cell(2,1,2,3, true)
		.string("TẬP ĐOÀN CN THAN - KS VIỆT NAM")
		.style(baseStyle)
		.style({font: {bold: true}})
		ws.cell(3,1,3,3, true)
		.string("CÔNG TY CP THAN MÔNG DƯƠNG-VINACOMIN")
		.style(baseStyle)
		.style({font: {bold: true}})

		ws.cell(2,4,2,colCount, true)
		.string("TẬP ĐOÀN CN THAN - KS VIỆT NAM")
		.style(baseStyle)
		.style({font: {bold: true}})

		ws.cell(3,4,3,colCount, true)
		.string("Độc lập - Tự do - Hạnh phúc")
		.style(baseStyle)
		.style({font: {bold: true}})

		ws.cell(4,4,4,colCount, true)
		.string("Mông dương, ngày    tháng   năm 20  ")
		.style(baseStyle)
		.style({font: {italics: true},alignment: {horizontal: "right"}})

		ws.cell(5,1,5,colCount,true)
		.string(title)
		.style(baseStyle)
		.style({font: {bold: true}});

		ws.cell(6,1,6,colCount,true)
		.string("Biểu 01/TN.TK.KH")
		.style(baseStyle)
		.style({font: {italics: true},alignment: {horizontal: "right"}});

		ws.cell(7,1,9,1,true)
		.string("TT")
		.style(baseStyle)
		.style({font: {bold: true}});

		ws.cell(7,2,9,2,true)
		.string("Tên chỉ tiêu")
		.style(baseStyle)
		.style({font: {bold: true}});

		ws.cell(7,3,9,3,true)
		.string("ĐVT")
		.style(baseStyle)
		.style({font: {bold: true}});

		// the rest
		for(i = 4; i < columns.length+4; i++){
			ws.cell(7, i,9,i,true)
			.string(columns[i-4])
			.style(baseStyle)
			.style({font: {bold: true}});
		}

	}
	else if(docType == REPORT_TYPES.THEO_DOI){
		// Main Title
		ws.cell(1,1,1,colCount,true)
		.string(title)
		.style(baseStyle)
		.style({font: {bold: true}});

		// TT Cot 1
		ws.cell(2,1)
		.string('T')
		.style(baseStyle)
		.style({font: {bold: true}});
		ws.cell(3,1)
		.string('T')
		.style(baseStyle)
		.style({font: {bold: true}});

		// Ten Chi Tieu
		ws.cell(2,2)
		.string('Tên')
		.style(baseStyle)
		.style({font: {bold: true}});
		ws.cell(3,2)
		.string('chỉ tiêu')
		.style(baseStyle)
		.style({font: {bold: true}});

		// Don vi cot 3
		ws.cell(2,3)
		.string('Đ.V')
		.style(baseStyle)
		.style({font: {bold: true}});
		ws.cell(3,3)
		.string('tính')
		.style(baseStyle)
		.style({font: {bold: true}});

		// // Tong K.luong
		// ws.cell(2,4)
		// .string('TỔNG')
		// .style(baseStyle)
		// .style({font: {bold: true}});
		// ws.cell(3,4)
		// .string('K.LƯỢNG')
		// .style(baseStyle)
		// .style({font: {bold: true}});

		// TONG SO -> GHI CHU:
		// ws.cell(2,5,2,colCount-1, true)
		// .string('Khối lượng CBSX')
		// .style(baseStyle)
		// .style({font: {bold: true}, alignment: {horizontal: "left"},border: {bottom:{style:'thin', color: "#000000"}}});

		// ws.cell(3,5)
		// .string('TỔNG SỐ')
		// .style(baseStyle)
		// .style({font: {bold: true}});

		ws.cell(2,colCount)
		.string('Ghi')
		.style(baseStyle)
		.style({font: {bold: true}});
		ws.cell(3,colCount)
		.string('Chú')
		.style(baseStyle)
		.style({font: {bold: true}});

		for(i = 4; i < colCount; i++){
			ws.cell(3, i)
			.string(columns[i-4])
			.style(baseStyle)
			.style({font: {bold: true}});
		}
	}
}

function arabicToRoman(number) {
  let roman = "";
  const romanNumList = {
    M: 1000,
    CM: 900,
    D: 500,
    CD: 400,
    C: 100,
    XC: 90,
    L: 50,
    XV: 40,
    X: 10,
    IX: 9,
    V: 5,
    IV: 4,
    I: 1
  };
  let a;
  if (number < 1 || number > 3999) return '';
  else {
    for (let key in romanNumList) {
      a = Math.floor(number / romanNumList[key]);
      if (a >= 0) {
        for (let i = 0; i < a; i++) {
          roman += key;
        }
      }
      number = number % romanNumList[key];
    }
  }

  return roman;
}

function vSum(data, idx, col){
	let masterLevel = parseInt(data[idx].level);
	let i = idx;
	let sum = 0;
	let children = [];
	while (i < data.length){
		i++;
		let currentLevel = parseInt(data[i].level)
		if( currentLevel == masterLevel) break;
		else if(currentLevel == masterLevel + 1){
			if(col == -1)
				currentVal = parseFloat(data[i].value)
			else{
				currentVal = parseFloat(data[i].value[col])
				if(!isNaN(currentVal)) 
					sum += currentVal
				else 
					sum += vSum(data, i, col).sum;
			}

			children.push(i);	// row
		}
	}
	return {children, sum};
}


function writeWorksheet(wb, ws, title, columns, data, docType, filename) {
	
	let rowCount = 0, colCount = 0, offsetRow = 0, offsetCol = 0;	// offset for data writing
	
	if(docType == REPORT_TYPES.TONG_HOP){
		offsetRow = 9;
		rowCount = data.length + offsetRow;		// first 9 rows are title + headers
		offsetCol = 3;
		colCount = columns.length + offsetCol;	// 3 col offset
	}
	else if(docType == REPORT_TYPES.THEO_DOI){
		offsetRow = 3;
		rowCount = data.length + offsetRow;		// first 9 rows are title + headers
		offsetCol = 4;
		colCount = columns.length + offsetCol; 	// 6 default cols (TT, Ten, DV, Tong KL, Tongso, Ghi chu)
	}
	
	const baseStyle = wb.createStyle({
		font: {
			color: "#000000",
			size: docType == REPORT_TYPES.THEO_DOI ? 9: 12,
			name: "Times New Roman"
		},
		numberFormat: "#,##0.00; (#,##0.00); -",
		alignment: {
			horizontal: "center",
			vertical: "center",
			wrapText: true
		},
	});
	
	// set Col Row style (width, height, boundary)
	for(r = 1; r <= rowCount; r++){
		setRowStyle(ws,r, rowCount,colCount, docType);
	}

	for(c = 1; c <= colCount; c++){
		setColumnStyle(ws,c, rowCount,colCount, docType);
	}
	
	// Text outline
	setTableOutline(ws, baseStyle, title, columns, colCount, docType);
	
	let indexCol = [0,0,0,0,0]; // maximum 5 level in index column
	// start writing data
	for(let idx = 0; idx < data.length; idx ++){
		let level, levelStyle, index, name, unit, value_type, value;
		level  = data[idx].level -1
		// set current level
		indexCol[level]++;
		// reset sublevel of this current one
		if(level < 5)indexCol[level+1] = 0;
		// ten formatting
		name = data[idx].name ? data[idx].name : "" ;
				
		// unit formatting
		unit = data[idx].DV ?data[idx].DV : "" ;
		unit = unit.replace(/\^2/g, "²");
		unit = unit.replace(/\^3/g, "³");

		// value
		value = data[idx].value;
		value_type = data[idx].value_type;
		// handle level style
		switch(level+1){
			case 1:
				// level formatting
				levelStyle = {
					font: {bold: true}
				}
				// TT formatting A B
				index = String.fromCharCode(indexCol[level] + "A".charCodeAt(0) -1)

				// ten formatting
				name = name.toUpperCase();
				
				// unit formatting
				unit = unit.toUpperCase();

				break;
			case 2:
				// level formatting I II
				levelStyle = {
					font: {bold: true, italics: true}
				}
				// TT formatting
				index = arabicToRoman(indexCol[level]);

				
				break;
			case 3:
				// level formatting
				levelStyle = {
					font: {italics: true}
				}
				// TT formatting 1 2 
				index = indexCol[level].toString();
				
				// ten formatting
				name = "- " + name;
				break;
			case 4:
				// level formatting
				levelStyle = {}

				// TT formatting 1.1 2.1
				index = indexCol[level-1].toString() +"."+ indexCol[level].toString();

				// ten formatting
				name = "+ " + name;
				break;
			case 5:
				
			default:
				// level formatting
				levelStyle = {}
				// TT formatting
				index = indexCol[level-2].toString() +"."+ indexCol[level-1].toString() +"."+ indexCol[level].toString();

				// ten formatting
				name = "  • " + name;
		}

		// write data to cell
		
		// TT
		ws.cell(idx + offsetRow + 1,1)
		.string(index)
		.style(baseStyle)
		.style(levelStyle);
		// Ten
		ws.cell(idx + offsetRow + 1,2)
		.string(name)
		.style(baseStyle)
		.style(levelStyle)
		.style({alignment: {horizontal: "left"}});
		// DV
		ws.cell(idx + offsetRow + 1,3)
		.string(unit)
		.style(baseStyle)
		.style(levelStyle);
		
		// Value
		
		for(i = 4; i < 4 + columns.length; i ++){
			
			if(!value[i-4] || !value_type[i-4]){
				ws.cell(idx + offsetRow + 1, i)
				.number(0)
				.style(baseStyle)
			}
			else{
				let children = [];
				if(value_type[i - 4] == DATA_ITEM_VALUE_TYPE.SUM_VERT){
					//value[i-4] = vSum(data, idx, i-4).sum
					children = vSum(data, idx, i-4).children;
					let row_first = offsetRow + 1 + children[0];
					let row_last = offsetRow + 1 + children[children.length-1];
					value[i-4] = `subtotal(9,indirect(address(` + row_first + `,` + i + `) &":"& address(` + row_last + `,` + i + `)))`
					ws.cell(idx + offsetRow + 1, i)
					.style(baseStyle)
					.formula(value[i-4])
				}
				else {
					value[i-4] = parseFloat(value[i-4])
					// for hSUM and undefined value, set to 0
					if(isNaN(value[i-4])) value[i-4] = 0;
					value[i-4].toFixed(2)
					ws.cell(idx + offsetRow + 1, i)
					.number(value[i - 4])
					.style(baseStyle)
				}
				
			}
		}
	}

	// Write file to destination
	wb.write(
		filename
	);
}

module.exports = {
	DATA_ITEM_VALUE_TYPE,
	DATA_GROUP_TYPES,
	REPORT_TYPES,
	USER_CHART_TYPES,

	getUserDivisionsForProject,

	getProjectStructure,
	saveProjectStructure,
	getProjectSumChildrenById,

	loadProjectData,
	updateProjectData,
	loadProjectReportData,
	addProjectData,
	getReportFilePath,
	writeReport2File,

	loadSampleData,
	writeWorksheet
}