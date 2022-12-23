const unorm = require('unorm');	// polyfill for String.prototype.normalize


const REMOVED_IDX = 1
const NAME_IDX = 2
const VALUE_IDX = 3
const UNIT_IDX = 4
let once = true;
let rowToHide = []
var hot, dataTable, tblOptions;

let removedRows = []

function vSum(instance, row, col, td, value, rowCount) {
	// get level of this cell:
	let level = parseInt(instance.getDataAtCell(row, 1));
	let sum = 0;

	// find all children starting from row below it
	let idx = row + 1;

	while (idx < rowCount) {
		let vLevel = parseInt(instance.getDataAtCell(idx, 1));

		// found an equal level row
		if (vLevel == level) {
			break;
		}
		// if child
		if (vLevel == level + 1) {
			
			
			let val = parseFloat(instance.getDataAtCell(idx, col));
			let valType = instance.getDataAtCell(idx, 4).toUpperCase();

			if(isNaN(val)){
				if (valType == SUM_VERT) {
					val = vSum(instance, idx, col, td, val, rowCount);
	
					let number = parseFloat(value);
					if (!isNaN(number)) {
						val = number.toFixed(2);
					}
				} else if (valType == SUM_HORZ) {
					value = "Tổng hàng";
					
				} else if (valType == USER_INPUT) {
					// incase user_input but no value
					value = "Dữ liệu nhập";
					val = 0;
				}
				else if (val == null){
					val = 0
				}
				val = parseFloat(val)
			}
			sum += val;
		}
		idx++;
	}
	return sum;
}

const USER_INPUT = "Dữ liệu nhập".toUpperCase().normalize("NFC"),
	SUM_VERT = "Tổng cột".toUpperCase().normalize("NFC"),
	SUM_HORZ = "Tổng hàng".toUpperCase().normalize("NFC"),
	IGNORE = "Ẩn dữ liệu".toUpperCase().normalize("NFC");

// Styling text
function styling(level, value, td, col) {
	switch (level) {
		case 1:
			//$('span').addClass('sheet-level1').text(value).appendTo(td);
			$("<span>")
				.addClass("sheet-level1 ")
				.html(value)
				.appendTo(td);
			break;
		case 2:
			$("<span>")
				.addClass("sheet-level2")
				.html(value)
				.appendTo(td);
			break;
		case 3:
			$("<span>")
				.addClass(`sheet-level3${col == 2 ? " sheet-col-ten" : ""}`)
				.html(value)
				.appendTo(td);
			break;
		case 4:
			$("<span>")
				.addClass(`sheet-level4${col == 2 ? " sheet-col-ten" : ""}`)
				.html(value)
				.appendTo(td);
			break;
		case 5:
			$("<span>")
				.addClass(`sheet-level5${col == 2 ? " sheet-col-ten" : ""}`)
				.html(value)
				.appendTo(td);
			break;
		default:
			$("<span>")
				.addClass(`sheet-level5${col == 2 ? " sheet-col-ten" : ""}`)
				.html(value)
				.appendTo(td);
	}
}

// custom renderer
var nameStyling = function (
	instance,
	td,
	row,
	col,
	prop,
	value,
	cellProperties
) {
	// ignore header
	while (td.firstChild) {
		td.removeChild(td.firstChild);
	}
	let level = instance.getDataAtCell(row, 1);
	if (typeof level == "string") level = parseInt(level);
	styling(level, value, td, col);
};

var unitStyling = function (
	instance,
	td,
	row,
	col,
	prop,
	value,
	cellProperties
) {
	// ignore header
	while (td.firstChild) {
		td.removeChild(td.firstChild);
	}
	let level = instance.getDataAtCell(row, 1);
	if (typeof level == "string") level = parseInt(level);

	if (value != null) {
		value = value.replace(/\^([234])/g, "<sup>$1</sup>");
	}
	td.style.textAlign = "center";
	styling(level, value, td, col);
};

var configDataStyling = function (
	instance,
	td,
	row,
	col,
	prop,
	value,
	cellProperties
) {
	// ignore header
	
	while (td.firstChild) {
		td.removeChild(td.firstChild);
	}
	
	let valueUpperCase 
	if(value) valueUpperCase = value.toUpperCase();
	let level = instance.getDataAtCell(row, 1);
	if (typeof level == "string") level = parseInt(level);
	
	if (valueUpperCase == SUM_VERT) {
		td.style.color = "blue";
	} else if (valueUpperCase == SUM_HORZ) {
		td.style.color = "blue";
	} else if (valueUpperCase == USER_INPUT) {
	} 
	// else {
	// 	instance.setDataAtCell(row, col, "Dữ liệu nhập");
	// }	// problematic
	styling(level, value, td, col);
};

var dataStyling = function (
	instance,
	td,
	row,
	col,
	prop,
	value,
	cellProperties
) {
	// ignore header
	while (td.firstChild) {
		td.removeChild(td.firstChild);
	}
	
	let level = instance.getDataAtCell(row, 1);
	if (typeof level == "string") level = parseInt(level);
	let value_type = instance.getDataAtCell(row, 4);
	
	let value_typeUpperCase
	if(typeof value_type == "string")
		value_typeUpperCase = value_type.toUpperCase();

	switch (value_typeUpperCase) {
		case SUM_VERT:
			instance.setCellMeta(row, col, "readOnly", true);
			value = vSum(instance, row, col, td, value, instance.countRows());
			value = parseFloat(value);
			if (!isNaN(value)) {
				value = value.toFixed(2);
			}

			td.style.color = "blue";
			td.style.textAlign = "right";
			break;
		case SUM_HORZ:
			instance.setCellMeta(row, col, "readOnly", true);
			td.style.color = "blue";
			break;
		case USER_INPUT:
			let number = parseFloat(value);
			if (!isNaN(number)) {
				value = number.toFixed(2);
			} else {
				value = 0;
			}
			td.style.textAlign = "right";
			break;
		case IGNORE:
			rowToHide.push(row)
			break;
		default:
			value = 0;
			
	}

	if (value == 0) value = "-";
	styling(level, value, td, col);
};

function makeColumns(isConfig){
	let columns = [
		{
			data: "id",
			type: "numeric"
		},
		{
			data: "level",
			type: "numeric"
		},
		{
			data: "name",
			type: "text",
			renderer: "nameStyling"
		},
		{
			data: "unit",
			type: "text",
			renderer: "unitStyling"
		},

		isConfig ? {
			data: "value_type",
			renderer: "configDataStyling",
			editor: "select",
			selectOptions: [USER_INPUT, IGNORE, SUM_VERT],
			readOnly: false

		} : {
			data: "value_type",		
			type: "text",
			readOnly: true
		}
	]
	if(!isConfig){
		columns.push(
			{
				data: "value",				
				renderer: "dataStyling",
				type: "numeric",
				readOnly: sheetReadonly
			}
		)
	}
	return columns;
}

function makeColumnsHeader(isConfig){
	if(isConfig) 
		return ["id", "level", "Tên chỉ tiêu", "Đơn vị",'Giá trị'] 
	else {
		return ["id", "level", "Tên chỉ tiêu", "Đơn vị",'Giá trị', 'Khối lượng'];
	}
}

function onRemoveRow(index, amount, physicalRows){
	if(isConfig){
		let row = hot.getDataAtRow(physicalRows)
		row[4] = IGNORE
		removedRows.push(row)
	}
}

function onCreateRow(index, amount){
	if(isConfig){
		let dataTable = hot.getData();
		// set ID
		let maxID = 0;
		let maxIndent = 5;
		maxID = Math.max(
			dataTable.reduce(
				(m, e) => Math.max(m, parseInt(e[0])),
				parseInt(dataTable[0][0])
			) + 1,
			maxID
		);
		hot.setDataAtCell(index, 0, maxID++);

		// set level
		hot.setDataAtCell(index, 1, maxIndent);

		// set tên
		hot.setDataAtCell(index, 2, "Chỉ tiêu mới");

		// set đơn vị
		hot.setDataAtCell(index, 3, "đơn vị");

		// set tổng khối lượng
		hot.setDataAtCell(index, 4, USER_INPUT);
	}
}

$(function () {
	rowToHide = [];
	
	// register custom renderer
	Handsontable.renderers.registerRenderer("nameStyling", nameStyling);
	Handsontable.renderers.registerRenderer("unitStyling", unitStyling);
	Handsontable.renderers.registerRenderer(
		"configDataStyling",
		configDataStyling
	);
	Handsontable.renderers.registerRenderer("dataStyling", dataStyling);

	const maxIndent = 5;
	let maxID = -1;
	// var hotElement = document.querySelector("#hot");
	
	tblOptions = {
		stretchH: "all",
		rowHeaders: true,
		colHeaders: true,
		height: "70vh",
		autoColumnSize: true,
		contextMenu: isConfig,
		outsideClickDeselects: !isConfig,
		allowInsertRow: isConfig,
		allowInsertColumn: isConfig,
		readOnly: !isConfig,
		columns: makeColumns(isConfig),

		colHeaders: makeColumnsHeader(isConfig),
		hiddenColumns: {
			columns: isConfig ? [0,1] : [0,1,4],
			indicator: false
		},
		HiddenRows: {
			indicator: false,
			rows: rowToHide
		},
		filters: true,

		licenseKey: "non-commercial-and-evaluation"
	}
	
	$("#hot").handsontable(tblOptions);

	hot = $("#hot").handsontable("getInstance");

	Handsontable.hooks.add('beforeRemoveRow', onRemoveRow, hot);
	Handsontable.hooks.add('afterCreateRow', onCreateRow, hot);



	if (isConfig) {
		hot.loadData(data);
		dataTable = hot.getData();

		function indentation(isIndent) {
			let selected = hot.getSelected();
			let startRow, endRow;

			// find start => end rows (only valid for consecutive selection)
			for (var index = 0; index < selected.length; index += 1) {
				var item = selected[index];
				startRow = Math.min(item[0], item[2]);
				endRow = Math.max(item[0], item[2]);
				for (var rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
					// get row's data
					let level = hot.getDataAtCell(rowIndex, 1);
					level = parseInt(level, 10);

					// set level for current row
					if (isIndent) {
						if (level == maxIndent) return;
						level = level + 1;
					} else {
						if (level == 1) return;
						level = level - 1;
					}

					hot.setDataAtCell(rowIndex, 1, level);
				}
			}

			//hot.selectCell(currentRow, currentCol);
		}

		$("#saveBtnCfg").click(function () {
			let data = hot.getSourceData();
			removedRows.forEach(r => {
				data.push({id: r[0], level: r[1], name:r[2], unit:r[3], value_type:r[4]})
			})
			kajax({
				url: saveConfigURL,
				method: "POST",
				data: {
					structure: data
				}
			}, () => notify('Đã lưu thành công.'));
		});

		$("#indentBtn").click(function () {
			indentation(true);
		});

		$("#outdentBtn").click(function () {
			indentation(false);
		});
	}
	else {
		const dp = sheetStaticData ? null : $(".date-picker");
		function reloadData() {
			const postData = {
				type: dataType
			};
			if (!sheetStaticData) postData.date = dp.val();


			$.post(loadURL, postData)
				.success(ret => {
					if (ret.msg != "OK") return notify(ret.msg);
					let filtered = ret.data.filter((obj) => {
						return obj.value_type != IGNORE
					})
					// check if there is extra values (value1, value2 ... global report)
					tblOptions.colHeaders = makeColumnsHeader(false)
					tblOptions.columns = makeColumns(false);

					sheetColumns.forEach(sC => {
						tblOptions.colHeaders.push(sC.title)
						tblOptions.columns.push({
							data: sC.name,				
							renderer: "dataStyling",
							type: "numeric",
							readOnly: sheetReadonly
						})
					})
					
					tblOptions.hiddenColumns.columns.push(5)
					$("#hot").handsontable(tblOptions);
					
					hot.loadData(filtered);


				})
				.fail(err => {
					console.log(err);
				});
		}

		function saveData() {
			const postData = {
				type: dataType,
				data: hot.getSourceData()
			};
			if (!sheetStaticData) postData.date = dp.val();

			$.ajax({
				url: saveURL,
				type: "POST",
				data: JSON.stringify(postData),
				contentType: "application/json; charset=utf-8",
				dataType: "json",
				success: function (ret) {
					if (ret.msg != "OK")
						return notify(ret.msg);
					notify("Đã lưu dữ liệu");
				},
				fail: function (err) {
					console.log(err);
				}
			});
		}

		reloadData();

		$("#refreshBtn").click(reloadData);
		$("#saveBtn").click(saveData);

		if (!sheetStaticData) {
			dp.change(reloadData).datepicker({
				autoclose: true,
				assumeNearbyYear: true,
				format: monthDate ? "mm/yyyy" : "dd/mm/yyyy",
				language: "vi",
				orientation: "bottom",
				todayHighlight: true,
				disableTouchKeyboard: true,
				minViewMode: 1,
				zIndexOffset: 1000
			});
		}
	}
});
