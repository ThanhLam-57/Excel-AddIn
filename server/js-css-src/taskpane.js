const unorm = require('unorm');	// polyfill for String.prototype.normalize


const SHEET_TYPE = {
    ...DATA_GROUP_TYPES,

    CAU_TRUC_BANG: 100,
    TONG_HOP: 101
};

const SHEET_INFO_PROP_NAME = 'klmo$sheetInfo';

const SPECIAL_COLUMN = {
    INFO:               { value: '{info}', name: 'Thông tin' },
    ITEM_LEVEL:         { value: '{level}', name: 'Thứ tự chỉ tiêu' },
    ITEM_NAME:          { value: '{name}', name: 'Tên chỉ tiêu' },
    ITEM_UNIT:          { value: '{unit}', name: 'Đơn vị chỉ tiêu' },
    ITEM_VALUE_TYPE:    { value: '{value_type}', name: 'Cách tính chỉ tiêu' }
};

const IGNORED_ROW_VALUE = '{ignored}';

const SPECIAL_DIVISION_INFO = [
    { id: 'all', name: 'Tất cả đơn vị', value: null }
];
const SPECIAL_PROJECT_INFO = [
    { id: 'all', name: 'Tất cả công trình', value: null }
];
const SPECIAL_GLOBAL_PLAN_INFO = [
    { id: '-', name: null, value: null }
];

const FP_TOL = 1e-10;   // floating point tolerance

const generalInfoCache = {};


// extract a subset of properties from one object
function pickObjProps(obj, props) {
    return Object.assign({}, ...props.map(e => ({[e]: obj[e]})));
}


function colIdx2Name(idx) {
    let major = 0, minor = idx, name = '';
    for (;;) {
        major = Math.floor(minor / 26);
        minor = minor % 26;

        name = String.fromCharCode('A'.charCodeAt(0) + minor) + name;

        if (major > 0) {
            minor = major - 1;
            major = 0;
        } else break;
    }

    return name;
}


function excelApiSupported(version) {
    return Office.context.requirements.isSetSupported('ExcelApi', version);
}

// polyfill for API <= 1.7
function getRangeByIndexes(worksheet, startRow, startCol, rowCount, colCount) {
    if (excelApiSupported('1.7')) return worksheet.getRangeByIndexes(startRow, startCol, rowCount, colCount);

    const rangeName = `${colIdx2Name(startCol)}${startRow + 1}:${colIdx2Name(startCol + colCount - 1)}${startRow + rowCount}`;
    console.log(rangeName)
    return worksheet.getRange(rangeName);
}


function showPaneDialog({title, content, onOk, noActions}) {
    const dom = $(`<div class="modal fade" tabindex="-1" role="dialog" aria-hidden="true">
        <div class="modal-dialog modal-fullscreen" role="document">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">${title}</h5>
                    ${noActions ? '' : `<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Đóng"></button>`}
                </div>
                <div class="modal-body">${content}</div>

                ${noActions ? '' : `<div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Đóng</button>
                    <button type="button" class="btn btn-primary">Đồng ý</button>
                </div>`}
            </div>
        </div>
    </div>`);

    const modal = new bootstrap.Modal(dom[0], {
        keyboard: !noActions
    });
    dom.on('shown.bs.modal', () => dom.find('.modal-body').find('select, input, textarea, button').first().focus());

    if (onOk) dom.find('.btn-primary').click(onOk);

    modal.show();
    return {modal, dom};
}


function showBreakingError(msg) {
    showPaneDialog({
        title: 'Lỗi',
        content: msg,
        noActions: true
    });
}


// still not used
// function confirmPaneDialog(title, content) {
//     return new Promise((resolve, reject) => {
//         const dlg = showPaneDialog({
//             title,
//             content,
//             onOk: () => {
//                 dlg.modal.hide();
//                 resolve(true);
//             }
//         });

//         dlg.dom.on('hidden.bs.modal', reject);
//     })
// }


function openUrlDlg(url) {
    Office.context.ui.openBrowserWindow(location.origin + url);
}


async function setCustomProperty(name, value) {
    return await Excel.run(async context => {
        const worksheet = context.workbook.worksheets.getActiveWorksheet();
        
        // Only available in API >= 1.12
        //const customProperties = worksheet.customProperties;

        // Workaround for API <= 1.11
        context.workbook.load('id');
        await context.sync();
        name = `--klmo-sheet-${worksheet.id}:${name}`;
        const customProperties = context.workbook.properties.custom;

        customProperties.add(name, JSON.stringify(value));  // override if key is existing
    });
}

async function getCustomProperty(name) {
    return await Excel.run(async context => {
        const worksheet = context.workbook.worksheets.getActiveWorksheet();
        
        // Only available in API >= 1.12
        //const customProperties = worksheet.customProperties;

        // Workaround for API <= 1.11
        context.workbook.load('id');
        await context.sync();
        name = `--klmo-sheet-${worksheet.id}:${name}`;
        const customProperties = context.workbook.properties.custom;

        const prop = customProperties.getItemOrNullObject(name).load("key, value");
        await context.sync();

        if (prop.isNullObject) return null;
        return JSON.parse(prop.value);
    });
}


async function setSheetInfo(sheetType, sheetTransposed, planId) {
    const infoStr = `{${sheetType};${sheetTransposed ? '1' : '0'};${planId ?? '-'}}`;
    await setCustomProperty(SHEET_INFO_PROP_NAME, infoStr);
}

async function getSheetInfo() {
    const info = {
        sheetType: null,
        sheetTransposed: null,
        planId: null
    }

    const infoStr = await getCustomProperty(SHEET_INFO_PROP_NAME);
    if (!infoStr) return info;

    const match = infoStr.match(/^\{([0-9]+);([0-9]+);(-|[0-9]+)\}$/);
    if (match == null || match.length != 4) return info;

    info.sheetType = +match[1];
    info.sheetTransposed = +match[2] != 0;
    info.planId = (match[3] == '-' ? null : +match[3]);
    return info;
}



const VALUE_TYPE_NAME_2_CODE_MAP = {
    [DATA_ITEM_VALUE_TYPE.USER_INPUT.toLowerCase().normalize('NFC')]: 1,
    [DATA_ITEM_VALUE_TYPE.SUM_VERT.toLowerCase().normalize('NFC')]: 2,
    [DATA_ITEM_VALUE_TYPE.IGNORE.toLowerCase().normalize('NFC')]: 3
};
const VALUE_TYPE_CODE_2_NAME_MAP = {
    1: DATA_ITEM_VALUE_TYPE.USER_INPUT,
    2: DATA_ITEM_VALUE_TYPE.SUM_VERT,
    3: DATA_ITEM_VALUE_TYPE.IGNORE
};

function valueTypeName2Code(name) {
    return VALUE_TYPE_NAME_2_CODE_MAP[name.toLowerCase().normalize('NFC')];
}

function valueTypeCode2Name(code) {
    return VALUE_TYPE_CODE_2_NAME_MAP[code];
}


// {id,level,value_type}
function encodeRowInfo(sheetType, info) {
    const value_type_code = info.value_type_code ?? valueTypeName2Code(info.value_type);
    return `{${info.id};${info.level};${value_type_code}}`;
}

function decodeRowInfo(sheetType, value) {
    if (value.match == undefined) return null;

    const match = value.match(/^\{([0-9]+);([0-9]+);([0-9]+)\}$/);
    if (match == null || match.length != 4) return null;

    const value_type_code = +match[3];
    return {
        id: +match[1],
        level: +match[2],
        value_type: valueTypeCode2Name(value_type_code),
        value_type_code
    }
}

// TONG_HOP: {dataType;division;project;globalPlan;begin-date;end-date}
// others: {division;project;date}
function encodeColInfo(sheetType, info) {
    if (sheetType == SHEET_TYPE.TONG_HOP) {
        const beginDateStr = moment(info.beginDate).format('YYYYMMDD');
        const endDateStr = moment(info.endDate).format('YYYYMMDD');
        return `{${info.dataType};${info.division};${info.project};${info.globalPlan ?? '-'};${beginDateStr};${endDateStr}}`;
    } else {
        const dateStr = moment(info.date).format('YYYYMMDD');
        return `{${info.division};${info.project};${dateStr}}`;
    }
}

// division, project, globalPlan are decoded to objects if they have special values, otherwise numbers representing their IDs.
function decodeColInfo(sheetType, value) {
    if (value.match == undefined) return null;

    if (sheetType == SHEET_TYPE.TONG_HOP) {
        const match = value.match(/^\{([0-9]+);(all|[0-9]+);(all|[0-9]+);(-|[0-9]+);([0-9]{8});([0-9]{8})\}$/);
        if (match == null || match.length != 7) return null;

        const specialDiv = SPECIAL_DIVISION_INFO.find(e => e.id == match[2]);
        const specialPrj = SPECIAL_PROJECT_INFO.find(e => e.id == match[3]);
        const specialPlan = SPECIAL_GLOBAL_PLAN_INFO.find(e => e.id == match[4]);

        return {
            dataType: +match[1],
            division: specialDiv ?? +match[2],
            project: specialPrj ?? +match[3],
            globalPlan: specialPlan ?? +match[4],
            beginDate: moment(match[5], 'YYYYMMDD'),
            endDate: moment(match[6], 'YYYYMMDD')
        };
    } else {
        const match = value.match(/^\{(all|[0-9]+);(all|[0-9]+);([0-9]{8})\}$/);
        if (match == null || match.length != 4) return null;

        const specialDiv = SPECIAL_DIVISION_INFO.find(e => e.id == match[1]);
        const specialPrj = SPECIAL_PROJECT_INFO.find(e => e.id == match[2]);

        return {
            division: specialDiv ?? +match[1],
            project: specialPrj ?? +match[2],
            date: moment(match[3], 'YYYYMMDD')
        };
    }
}



function getGeneralInfo(what, fresh) {
    if (!fresh) what = what.filter(e => !generalInfoCache.hasOwnProperty(e));

    return new Promise((resolve, reject) => {
        if (what.length == 0) return resolve(generalInfoCache);

        kajax({
            method: 'post',
            url: _UrlBase + '/excel/pull/general-info',
            data: {
                projectStructure: what.includes('projectStructure'),
                divisions: what.includes('divisions'),
                projects: what.includes('projects'),
                globalPlans: what.includes('globalPlans')
            }
        }, data => {
            if (data.hasOwnProperty('projectStructure')) generalInfoCache.projectStructure = data.projectStructure;
            if (data.hasOwnProperty('divisions')) generalInfoCache.divisions = data.divisions;
            if (data.hasOwnProperty('projects')) generalInfoCache.projects = data.projects;
            if (data.hasOwnProperty('globalPlans')) generalInfoCache.globalPlans = data.globalPlans;
            resolve(generalInfoCache);
        }, err => {
            reject();
        });
    });
}


function globalPlans2SelectOptions(globalPlans, currentSelId) {
    return [... new Set(globalPlans.map(e => e.year))]    // unique years
        .sort((a, b) => b - a) // sort years descending
        .map(year => `<optgroup label="${year}">` +
            globalPlans.filter(e => e.year == year).map(e => `<option value="${e.id}" ${currentSelId == e.id ? 'selected' : ''}>${e.name}</option>`).join('') +
            '</optgroup>').join('');
}

function projects2SelectOptions(projects, currentSelId) {
    const endYears = projects.map(e => e.end_date ? moment(e.end_date).year() : '-');

    return [... new Set(endYears)]    // unique years
        .sort((a, b) => { // sort years descending; null years go first
            if (a == '-' && b == '-') return 0;
            if (a == '-') return -1;
            if (b == '-') return 1;
            return b - a;
        })
        .map(year => `<optgroup label="${year == '-' ? 'Chưa xác định năm' : year}">` +
            projects.filter((e, i) => endYears[i] == year).map(e => `<option value="${e.id}" ${currentSelId == e.id ? 'selected' : ''}>${e.name}</option>`).join('') +
            '</optgroup>').join('');
}


function setInfoBarContent(content) {
    $('.info-bar').html(content);
}

async function updateInfoBar() {
    if (!IS_LOGGED_IN) return;

    const {sheetType, sheetTransposed, planId} = await getSheetInfo();
    if (sheetType == null) return setInfoBarContent('Trang tính chưa khởi tạo.');

    const content = [];

    if (sheetType == SHEET_TYPE.KE_HOACH) {
        const {globalPlans} = await getGeneralInfo(['globalPlans'], false);
        const planInfo = globalPlans.find(e => e.id == planId);
        content.push(`Bảng dữ liệu kế hoạch${planInfo ? `: ${planInfo.name}` : ''}${sheetTransposed ? ' (ngang)' : ''}.`);
    } else {  
        content.push({
            [SHEET_TYPE.THUC_HIEN]: 'Bảng dữ liệu thực hiện',
            [SHEET_TYPE.KIEM_TRA_KCS]: 'Bảng dữ liệu kiểm tra KCS',
            [SHEET_TYPE.KIEM_TRA_KY_THUAT]: 'Bảng dữ liệu kiểm tra kỹ thuật',
            [SHEET_TYPE.CAU_TRUC_BANG]: 'Bảng định nghĩa cấu trúc chỉ tiêu',
            [SHEET_TYPE.TONG_HOP]: 'Bảng báo cáo tổng hợp'
        }[sheetType] + `${sheetTransposed ? ' (ngang)' : ''}.`);
    }

    Excel.run(async context => {
        const worksheet = context.workbook.worksheets.getActiveWorksheet();
        const selRange = context.workbook.getSelectedRange().load('columnIndex, rowIndex, isEntireRow, isEntireColumn');
        await context.sync();

        if (!selRange.isEntireRow) {
            const infoCell = getRangeByIndexes(worksheet, 0, selRange.columnIndex, 1, 1).load('values');
            await context.sync();

            const value = infoCell.values[0][0];
            const specialCol = Object.values(SPECIAL_COLUMN).find(e => e.value == value);
            if (specialCol) content.push(`- Cột: ${specialCol.name}.`);
            else {
                const info = decodeColInfo(sheetType, value);
                if (info == null) content.push('- Cột chưa khởi tạo.');
                else {
                    const {divisions, projects, globalPlans} = await getGeneralInfo(['divisions', 'projects', 'globalPlans'], false);
                    const pieces = [];

                    if (sheetType == SHEET_TYPE.TONG_HOP) {
                        pieces.push({
                            [DATA_GROUP_TYPES.KE_HOACH]: 'Kế hoạch',
                            [DATA_GROUP_TYPES.THUC_HIEN]: 'Thực hiện',
                            [DATA_GROUP_TYPES.KIEM_TRA_KCS]: 'Kiểm tra KCS',
                            [DATA_GROUP_TYPES.KIEM_TRA_KY_THUAT]: 'Kiểm tra kỹ thuật'
                        }[info.dataType]);
                    }

                    if (typeof info.division == 'object') {
                        if (info.division.name) pieces.push(info.division.name);
                    } else {
                        const divInfo = divisions.find(e => e.id == info.division);
                        if (divInfo) pieces.push(divInfo.name);
                    }

                    if (typeof info.project == 'object') {
                        if (info.project.name) pieces.push(info.project.name);
                    } else {
                        const prjInfo = projects.find(e => e.id == info.project);
                        if (prjInfo) pieces.push(prjInfo.name);
                    }

                    if (sheetType == SHEET_TYPE.TONG_HOP) {
                        if (typeof info.globalPlan == 'object') {
                            if (info.globalPlan.name) pieces.push(info.globalPlan.name);
                        } else {
                            const planInfo = globalPlans.find(e => e.id == info.globalPlan);
                            if (planInfo) pieces.push(planInfo.name);
                        }

                        const dateFormat = info.dataType == SHEET_TYPE.KE_HOACH ? 'MM/YYYY' : 'DD/MM/YYYY';
                        pieces.push(info.beginDate.format(dateFormat) + (info.beginDate.isSame(info.endDate) ? '' : '-' + info.endDate.format(dateFormat)));
                        
                    } else {
                        pieces.push(info.date.format(sheetType == SHEET_TYPE.KE_HOACH ? 'MM/YYYY' : 'DD/MM/YYYY'));
                    }

                    content.push(`- Cột: ${pieces.join(', ')}.`);
                }
            }
        }

        if (!selRange.isEntireColumn) {
            if (selRange.rowIndex == 0) content.push('- Hàng: Thông tin.');
            else {
                const infoCell = getRangeByIndexes(worksheet, selRange.rowIndex, 0, 1, 1).load('values');
                await context.sync();

                const value = infoCell.values[0][0];

                if (value == IGNORED_ROW_VALUE) content.push('- Hàng: Dành riêng.');
                else {
                    const info = decodeRowInfo(sheetType, value);
                    if (info == null) content.push('- Hàng chưa khởi tạo.');
                    else content.push('- Hàng: Chỉ tiêu.');
                }
            }
        }

        setInfoBarContent(content.map(e => `<p>${e}</p>`).join(''));
    });
}


async function updateGUI() {
    const {sheetType} = await getSheetInfo();

    let klass = 'st-none';
    if (sheetType == SHEET_TYPE.CAU_TRUC_BANG) klass = 'st-cau-truc';
    else if (sheetType == SHEET_TYPE.KE_HOACH) klass = 'st-ke-hoach';
    else if (sheetType == SHEET_TYPE.THUC_HIEN) klass = 'st-thuc-hien';
    else if (sheetType == SHEET_TYPE.KIEM_TRA_KCS) klass = 'st-kiem-tra-kcs';
    else if (sheetType == SHEET_TYPE.KIEM_TRA_KY_THUAT) klass = 'st-kiem-tra-kt';
    else if (sheetType == SHEET_TYPE.TONG_HOP) klass = 'st-tong-hop';
    
    $(`.st.${klass}`).show();
    $(`.st:not(.${klass})`).hide();

    updateInfoBar();
}



// Format - Van
const INDENT_START = 3


// re-calculate STT & auto-sum columns for wholerange
async function normalizeSheet(worksheet, sheetType, wholerange, specialCols, dataCols, checkProjectStructure, highlightCells) {
    const indentLevel = [];
    const colSumStartRow = [];

    const sumVertValueTypeCode = valueTypeName2Code(DATA_ITEM_VALUE_TYPE.SUM_VERT);

    const updateVertSumCols = (idx, firstRow) => {
        const ri = colSumStartRow[idx];
        if (ri) {
            dataCols.forEach(colIdx => {
                const colName = colIdx2Name(wholerange.columnIndex + colIdx);
                const formula = (firstRow <= ri + 2 ? '--' :
                    `=SUBTOTAL(109,${colName}${wholerange.rowIndex + ri + 2}:${colName}${wholerange.rowIndex + firstRow})`);
                
                const range = getRangeByIndexes(worksheet, wholerange.rowIndex + ri, wholerange.columnIndex + colIdx, 1, 1);
                range.formulas = [[formula]];
                if (highlightCells) range.format.fill.color = '#D9D9D9';
            });
        }
    }

    const projectStructure = checkProjectStructure ? (await getGeneralInfo(['projectStructure'], true)).projectStructure : null;

    wholerange.values.forEach((row, i) => {
        const rowInfValue = row[specialCols[SPECIAL_COLUMN.INFO.value]];
        const rowInf = decodeRowInfo(sheetType, rowInfValue);
        if (!rowInf) return;

        if (checkProjectStructure) {
           const structureRow = projectStructure.find(e => e.id == rowInf.id);

            if (!structureRow) {
                // if item has been removed, remove the row too
                row[specialCols[SPECIAL_COLUMN.INFO.value]] = '';
                return;
            } else {
                // if item has changed, update the row info cell
                const newRowInfValue = encodeRowInfo(sheetType, structureRow);
                if (newRowInfValue.localeCompare(rowInfValue) != 0) {
                    row[specialCols[SPECIAL_COLUMN.INFO.value]] = newRowInfValue;
                    rowInf.level = structureRow.level;
                    rowInf.value_type = structureRow.value_type;
                    rowInf.value_type_code = valueTypeName2Code(structureRow.value_type);
                }
            }
        }
        
        // Tính STT
        const levelNum = (({level}) => {
            if (level > indentLevel.length)
                indentLevel.push(... Array(level - indentLevel.length).fill(1));
            else {
                indentLevel.length = level;
                indentLevel[level - 1]++;
            }
        
            return indentLevel.join('.');
        })(rowInf);

        // Tính tổng cột
        (({level, value_type_code}) => {
            if (level > colSumStartRow.length) {
                colSumStartRow.push(... Array(level - colSumStartRow.length));
            } else {
                for (let ii = level - 1; ii < colSumStartRow.length; ii++)
                    updateVertSumCols(ii, i);
                colSumStartRow.length = level;
            }

            colSumStartRow[level - 1] = (value_type_code == sumVertValueTypeCode ? i : undefined);
        })(rowInf);

        const currentRow = wholerange.getRow(i)
        normalizeRow(rowInf.level, currentRow, row, specialCols, levelNum)
    });

    for (let ii = 0; ii < colSumStartRow.length; ii++)
        updateVertSumCols(ii, wholerange.rowCount);
}

function normalizeRow(level, range, rowData, specialCols, levelNum) {
    const nameCol = specialCols[SPECIAL_COLUMN.ITEM_NAME.value];
    const levelCol = specialCols[SPECIAL_COLUMN.ITEM_LEVEL.value];

    switch(level){
        case 1:
            // Uppercase
/*            [SPECIAL_COLUMN.ITEM_NAME, SPECIAL_COLUMN.ITEM_UNIT, SPECIAL_COLUMN.ITEM_VALUE_TYPE].map(e => specialCols[e.value]).forEach(i => {
                if (typeof rowData[i] == "string"){
                    rowData[i] = rowData[i].toUpperCase()
                }
            });*/

            // Make level number
            range.getCell(0, nameCol).format.indentLevel = 0
            range.format.font.bold = true;
            range.format.font.italic = false;
            range.format.font.size = 14;
            break;

        case 2:
            range.getCell(0, nameCol).format.indentLevel = 0
            range.format.font.bold = true;
            range.format.font.italic = true;
            range.format.font.size = 12;    
            break;

        case 3:
            range.getCell(0, nameCol).format.indentLevel = level - INDENT_START + 1;
            range.format.font.bold = false;
            range.format.font.italic = true;
            range.format.font.size = 12;
            break;

        case 4: 
            range.getCell(0, nameCol).format.indentLevel = level - INDENT_START + 1;
            range.format.font.bold = false;
            range.format.font.italic = false;
            range.format.font.size = 11;
            break;

        case 5: 
            range.getCell(0, nameCol).format.indentLevel = level - INDENT_START + 1;
            range.format.font.bold = false;
            range.format.font.italic = false;
            range.format.font.size = 11;
            break;

        default:
            range.getCell(0, nameCol).format.indentLevel = level - INDENT_START + 1;
    }
    
    rowData[levelCol] = levelNum;
    range.values = [rowData];

    const cell = range.getCell(0, levelCol);
    cell.format.horizontalAlignment = "Right"
    cell.format.font.italic = true
}


async function formatSheet(checkProjectStructure, highlightCells) {
    const {sheetType} = await getSheetInfo();
    if (sheetType == null) return notify('Trang tính chưa được khởi tạo.');

    const specialCols = await requireSpecialColumns([SPECIAL_COLUMN.INFO.value, SPECIAL_COLUMN.ITEM_LEVEL.value]);
    if (!specialCols) return;

    await Excel.run(async context => {
        const worksheet = context.workbook.worksheets.getActiveWorksheet();
        const wholerange = worksheet.getUsedRange().load('rowIndex, columnIndex, rowCount, columnCount, values');
        await context.sync();

        const infoRowRange = getRangeByIndexes(worksheet, 0, wholerange.columnIndex, 1, wholerange.columnCount).load('values');
        await context.sync();

        const dataCols = [];
        infoRowRange.values[0].forEach((e, i) => {
            const info = decodeColInfo(sheetType, e);
            if (info) dataCols.push(i);
        });

        getRangeByIndexes(worksheet, 1, specialCols[SPECIAL_COLUMN.ITEM_LEVEL.value], 1, 1).getEntireColumn().numberFormat = '@';
        
        await normalizeSheet(worksheet, sheetType, wholerange, specialCols, dataCols, checkProjectStructure, highlightCells);
        await context.sync();
    }).catch(err => {
        console.log(err);
        notify('Lỗi: Không định dạng được bảng.')
    });
}


function OnReformatSheet() {
    formatSheet(true, false);
}

function OnReformatAndHighlightSheet() {
    formatSheet(true, true);
}


async function OnIndentation(isIndent) {
    const {sheetType} = await getSheetInfo();
    if (sheetType == null) return notify('Trang tính chưa được khởi tạo.');

    const specialCols = await requireSpecialColumns([SPECIAL_COLUMN.INFO.value]);
    if (!specialCols) return;

    Excel.run(async context => {
        const worksheet = context.workbook.worksheets.getActiveWorksheet();
        const selRange = context.workbook.getSelectedRange().getEntireRow().load('rowIndex, rowCount')
        await context.sync()
        
        for(let i = 0; i < selRange.rowCount; i ++){
            const infoCell = selRange.getCell(i, specialCols[SPECIAL_COLUMN.INFO.value]).load('values')
            await context.sync();

            let rowInf = decodeRowInfo(sheetType, infoCell.values[0][0]);
            if (!rowInf) rowInf = {id: null, level: 1};

            if (isIndent)
                rowInf.level ++
            else {
                rowInf.level --

                if (rowInf.level < 1)
                    rowInf.level = 1
            }

            infoCell.values = [[encodeRowInfo(sheetType, rowInf)]]
        }

        await context.sync()

        formatSheet(false, false);

    }).catch(err => {
        console.log(err);
        notify('Lỗi: Không thay đổi được cấp độ.')
    });
}

// End Format



// what: array of desired column values, or undefined for all
async function detectSpecialColumns(what) {
    return await Excel.run(async context => {
        const worksheet = context.workbook.worksheets.getActiveWorksheet();
        const usedRange = worksheet.getUsedRange().load('columnIndex, columnCount, values');
        await context.sync();

        const cols = {};
        Object.values(SPECIAL_COLUMN).forEach(e => {
            if (what != undefined && !what.includes(e.value)) return;
            cols[e.value] = null;
        });

        usedRange.values[0].forEach((colInfo, colIdx) => {
            const sc = Object.values(SPECIAL_COLUMN).find(e => e.value == colInfo);
            if (sc && cols[sc.value] === null) cols[sc.value] = colIdx;
        });

        return cols;
    });
}

async function requireSpecialColumns(required, optional) {
    const specialCols = await detectSpecialColumns(optional ? [...required, ...optional] : required);

    for (let col in specialCols) {
        if (specialCols[col] == null && required.includes(col)) {
            notify(`Không tìm thấy cột: ${SPECIAL_COLUMN[col].name}.`);
            return false;
        }
    }

    return specialCols;
}



async function initSheet(sheetType, sheetTransposed, planId, initStructure) {    
    let success = true;

    if (initStructure == 'info') {
        await Excel.run(async context => {
            const worksheet = context.workbook.worksheets.getActiveWorksheet();
            worksheet.getRange('A:A').insert('Right').columnHidden = true;
            worksheet.getRange('1:1').insert('Down').rowHidden = true;
            await context.sync();
            
            worksheet.getRange('A1').values = [[SPECIAL_COLUMN.INFO.value]];
            await context.sync();
        }).catch(err => {
            console.log(err);
            notify('Lỗi: Không khởi tạo được bảng.');
            success = false;
        });

    } else if (initStructure == 'table') {
        const {projectStructure} = await getGeneralInfo(['projectStructure'], true);
        const structureActive = projectStructure.filter(e => !e.removed);

        await Excel.run(async context => {
            const worksheet = context.workbook.worksheets.getActiveWorksheet();
            const wholerange = worksheet.getRange();
            wholerange.clear();
 
            const infoRowValues = [SPECIAL_COLUMN.INFO.value, SPECIAL_COLUMN.ITEM_LEVEL.value, SPECIAL_COLUMN.ITEM_NAME.value, SPECIAL_COLUMN.ITEM_UNIT.value];
            const headerTitles = [IGNORED_ROW_VALUE, 'STT', 'Tên chỉ tiêu', 'Đơn vị'];
            if (sheetType == SHEET_TYPE.CAU_TRUC_BANG) {
                infoRowValues.push(SPECIAL_COLUMN.ITEM_VALUE_TYPE.value);
                headerTitles.push('Cách tính');
            }

            const numDataRows = structureActive.length;
            const firstDataRow = 2;
            const numCols = infoRowValues.length;
            getRangeByIndexes(worksheet, 0, 0, 1, numCols).values = [infoRowValues];

            const headerRange = getRangeByIndexes(worksheet, 1, 0, 1, numCols);
            headerRange.values = [headerTitles];
            headerRange.format.font.bold = true;

            structureActive.forEach((row, i) => {
                const rowData = [encodeRowInfo(sheetType, row), '', row.name, row.unit];
                if (sheetType == SHEET_TYPE.CAU_TRUC_BANG) rowData.push(row.value_type);

                const rowRange = getRangeByIndexes(worksheet, firstDataRow + i, 0, 1, numCols);
                rowRange.values = [rowData];
            });

            if (sheetType == SHEET_TYPE.CAU_TRUC_BANG) {
                getRangeByIndexes(worksheet, firstDataRow, numCols - 1, numDataRows, 1).dataValidation.rule = {
                    list: {
                        inCellDropDown: true,
                        source: "Dữ liệu nhập, Tổng cột" // Tạm bỏ "Ẩn dữ liệu"
                    }
                };
            }

            if (excelApiSupported('1.2')) getRangeByIndexes(worksheet, 1, 1, numCols - 1, numDataRows + firstDataRow).format.autofitColumns();

            const infoRowRange = worksheet.getRange('1:1');
            infoRowRange.rowHidden = true;

            const infoColRange = worksheet.getRange('A:A');
            infoColRange.columnHidden = true;
        
            await context.sync();

        }).catch(err => {
            console.log(err);
            notify('Lỗi: Không khởi tạo được bảng.');
            success = false;
        });
    }

    if (success) {
        await setSheetInfo(sheetType, sheetTransposed, planId);
        
        if (initStructure == 'table') {
            formatSheet(false, false);
            updateGUI();
        }
    }
}



function fillPullDataToTable(tableData, retData, rowIndex, columnIndex, rowCount, columnCount) {
    return Excel.run(async context => {
        const worksheet = context.workbook.worksheets.getActiveWorksheet();

        tableData.forEach(row => {
            row.data.forEach((col, colIdx) => {
                if (!col.keep) getRangeByIndexes(worksheet, rowIndex + row.rowIdx, columnIndex + retData[colIdx].colIdx, 1, 1).values = [[col.new ?? '']];
            });
        });
        await context.sync();

        const noPermittedCols = tableData[0].data.filter(e => !e.permitted).length;
        notify(`Đã cập nhật xong (${rowCount} hàng × ${columnCount} cột${noPermittedCols == 0 ? '' : `, ${noPermittedCols} cột không có quyền`}).`);
        updateInfoBar();

    }).catch(err => {
        console.log(err);
        notify('Lỗi: Không gán được dữ liệu bảng.')
    });
}


function showDataDiffDlg(tableData, retData, rowIndex, columnIndex, rowCount, columnCount, changedCellsCount) {
    const rowChanged = tableData.map(row => row.data.some(e => e.changed));
    const colChanged = tableData[0].data.map((_, i) => tableData.some(row => row.data[i].changed));
    const cellWidth = `width:${100 / (tableData[0].data.length + (tableData[0].header ? 1 : 0))}%`;

    const dlg = showPaneDialog({
        title: `Cập nhật dữ liệu <span class="badge bg-warning"><span id="updates-count">${changedCellsCount}</span>/${changedCellsCount}</span>
            <div class="btn-group">
                <button class="btn btn-secondary btn-sm" id="btn-show-unchanged" data-bs-toggle="tooltip" title="Ẩn/hiện các hàng, cột không thay đổi"><i class="fas fa-fw fa-expand"></i></button>
                <button class="btn btn-secondary btn-sm" id="btn-keep-all" data-bs-toggle="tooltip" title="Chọn/Bỏ chọn hết"><i class="far fa-fw fa-check-square"></i></button>
            </div>`,
        content: `<table class="table table-bordered table-hover table-sm small diff-table">
                <tr>
                    ${tableData[0].header ? `<th class="text-center" style="${cellWidth}">STT</th>` : ''}
                    ${retData.map((col, colIdx) => `<th class="text-center ${colChanged[colIdx] ? 'toggle-col table-success cursor-pointer' : 'unchanged'}"
                        style="${cellWidth}" data-col-idx="${colIdx}">${colIdx2Name(columnIndex + col.colIdx)}</th>`).join('')}
                </tr>

                ${tableData.map((row, rowIdx) => {
                    let html = `<tr ${rowChanged[rowIdx] ? '' : 'class="unchanged"'}>`;
                    if (row.header) html += `<th class="text-end ${rowChanged[rowIdx] ? 'toggle-row table-success cursor-pointer' : ''}" data-row-idx="${rowIdx}">${row.header}</th>`;

                    html += row.data.map((e, colIdx) => {
                        if (Math.abs(e.old - e.new) <= FP_TOL || !e.permitted) {
                            return `<td class="text-secondary text-center position-relative ${e.permitted ? '' : 'table-warning'} ${colChanged[colIdx] ? '' : 'unchanged'}"
                            style="${cellWidth}" data-row-idx="${rowIdx}" data-col-idx="${colIdx}">
                                <i class="fas fa-arrow-circle-right goto-icon"></i>
                                ${e.old == '' ? '-' : e.old}
                            </td>`;
                        } else {
                            return `<td class="table-success text-center text-secondary cursor-pointer cell-changed position-relative"
                            style="${cellWidth}" data-row-idx="${rowIdx}" data-col-idx="${colIdx}">
                                <i class="fas fa-arrow-circle-right goto-icon"></i>
                                <span class="text-success">${e.new == '' ? '-' : e.new}</span>
                                (<span class="text-danger">${e.old == '' ? '-' : e.old}</span>)
                            </td>`;
                        }
                    }).join('');

                    html += '</tr>';
                    return html;
                }).join('')}
            </table>`,
        onOk: () => {
            dlg.modal.hide();
            fillPullDataToTable(tableData, retData, rowIndex, columnIndex, rowCount, columnCount);
        }
    });

    EnableTooltips(dlg.dom[0], { placement: 'bottom' });

    const updateUpdatesCount = () => {
        let count = 0;
        tableData.forEach(row => {
            row.data.forEach(e => {
                if (!e.keep) count++;
            });
        });
        dlg.dom.find('#updates-count').text(count);
    };
    updateUpdatesCount();

    dlg.dom.find('table .unchanged').hide();

    dlg.dom.find('#btn-show-unchanged').click(() => {
        const icon = dlg.dom.find('#btn-show-unchanged i');
        icon.toggleClass('fa-expand fa-compress');
        if (icon.hasClass('fa-compress'))
            dlg.dom.find('table .unchanged').show();
        else dlg.dom.find('table .unchanged').hide();

        updateUpdatesCount();
    });

    dlg.dom.find('#btn-keep-all').click(() => {
        const icon = dlg.dom.find('#btn-keep-all i');
        icon.toggleClass('far fas');
        const keep = icon.hasClass('fas');

        dlg.dom.find('.cell-changed').removeClass(keep ? 'table-success' : 'table-danger').addClass(keep ? 'table-danger' : 'table-success');
        tableData.forEach(row => {
            row.data.forEach(e => {
                if (e.changed) e.keep = keep;
            });
        });

        updateUpdatesCount();
    });

    dlg.dom.find('td').click(evt => {
        const cell = $(evt.target).closest('td');
        const rowIdx = cell.data('row-idx');
        const colIdx = cell.data('col-idx');

        if ($(evt.target).is('.goto-icon')) {
            Excel.run(async context => {
                const worksheet = context.workbook.worksheets.getActiveWorksheet();
                getRangeByIndexes(worksheet, rowIndex + tableData[rowIdx].rowIdx, columnIndex + retData[colIdx].colIdx, 1, 1).select();
                context.sync();
            });
            return;
        }

        if (cell.is('.cell-changed')) {
            cell.toggleClass('table-success table-danger');
            tableData[rowIdx].data[colIdx].keep = cell.hasClass('table-danger');
            updateUpdatesCount();
        }
    });

    dlg.dom.find('.toggle-row').click(evt => {
        const cell = $(evt.target).closest('.toggle-row');
        cell.toggleClass('table-danger table-success');

        const rowIdx = cell.data('row-idx');
        const keep = cell.hasClass('table-danger');

        cell.closest('tr').find('.cell-changed').addClass(keep ? 'table-danger' : 'table-success').removeClass(keep ? 'table-success' : 'table-danger');
        tableData[rowIdx].data.forEach(e => {
            if (e.changed) e.keep = keep;
        });

        updateUpdatesCount();
    });

    dlg.dom.find('.toggle-col').click(evt => {
        const cell = $(evt.target).closest('.toggle-col');
        cell.toggleClass('table-danger table-success');

        const colIdx = cell.data('col-idx');
        const keep = cell.hasClass('table-danger');

        cell.closest('table').find(`.cell-changed[data-col-idx=${colIdx}]`).addClass(keep ? 'table-danger' : 'table-success').removeClass(keep ? 'table-success' : 'table-danger');
        tableData.forEach(row => {
            if (row.data[colIdx].changed) row.data[colIdx].keep = keep;
        });

        updateUpdatesCount();
    });
}


async function processPullData(sheetType, sheetTransposed, planId, retData, rowIndex, columnIndex, rowCount, columnCount, showDiffDlg) {
    const specialCols = await requireSpecialColumns([SPECIAL_COLUMN.INFO.value], [SPECIAL_COLUMN.ITEM_LEVEL.value]);
    if (!specialCols) return;

    const userInputValueTypeCode = valueTypeName2Code(DATA_ITEM_VALUE_TYPE.USER_INPUT);

    Excel.run(async context => {
        const worksheet = context.workbook.worksheets.getActiveWorksheet();
        const infoColRange = getRangeByIndexes(worksheet, rowIndex, specialCols[SPECIAL_COLUMN.INFO.value], rowCount, 1).load('values');
        const levelColRange = (specialCols[SPECIAL_COLUMN.ITEM_LEVEL.value] ? getRangeByIndexes(worksheet, rowIndex, specialCols[SPECIAL_COLUMN.ITEM_LEVEL.value], rowCount, 1).load('values') : null);
        const selRange = getRangeByIndexes(worksheet, rowIndex, columnIndex, rowCount, columnCount).load('values');
        await context.sync();

        const tableData = [];
        selRange.values.forEach((row, rowIdx) => {
            const info = decodeRowInfo(sheetType, infoColRange.values[rowIdx][0]);
            if (!info || info.value_type_code != userInputValueTypeCode) return;  // consider only USER_INPUT rows, skip others

            tableData.push({
                id: info.id,
                rowIdx,
                value_type: info.value_type,
                header: (levelColRange ? levelColRange.values[rowIdx][0] : null),
                data: retData.map(col => ({
                    old: row[col.colIdx] ?? '',
                    new: '',
                    permitted: true,
                    keep: true,
                    changed: true
                }))
            });
        });

        retData.forEach((col, colIdx) => {
            col.data.forEach(row => {
                const tableRow = tableData.find(e => e.id == row.id);
                if (!tableRow) return;  // item not included in selected rows

                const tableCell = tableRow.data[colIdx];

                if (!col.status) {
                    tableCell.permitted = false;
                    return;
                }

                if (valueTypeName2Code(row.value_type) != userInputValueTypeCode) return;

                tableCell.new = row.value ?? '';
                if (tableCell.old != tableCell.new) {
                    tableRow.hasChanges = true;
                    tableCell.keep = false;
                } else tableCell.changed = false;
            });
        });

        let changedCellsCount = 0;
        tableData.forEach(row => {
            row.data.forEach(e => {
                if (e.old != e.new) changedCellsCount++;
            });
        });

        if (changedCellsCount == 0) return notify('Không có thay đổi nào.');

        if (showDiffDlg)
            showDataDiffDlg(tableData, retData, rowIndex, columnIndex, rowCount, columnCount, changedCellsCount);
        else fillPullDataToTable(tableData, retData, rowIndex, columnIndex, rowCount, columnCount);

    }).catch(err => {
        console.log(err);
        notify('Lỗi đọc dữ liệu bảng.');
    });
}


async function pullData(sheetType, sheetTransposed, planId, rowIndex, columnIndex, rowCount, columnCount, showDiffDlg) {
    const specialCols = await requireSpecialColumns([SPECIAL_COLUMN.INFO.value]);

    Excel.run(async context => {
        const worksheet = context.workbook.worksheets.getActiveWorksheet();
        const infoColRange = getRangeByIndexes(worksheet, rowIndex, specialCols[SPECIAL_COLUMN.INFO.value], rowCount, 1).load('values');
        const infoRowRange = getRangeByIndexes(worksheet, 0, columnIndex, 1, columnCount).load('values');
        await context.sync();

        const rowsInfo = [];
        infoColRange.values.forEach((e, i) => {
            const info = decodeRowInfo(sheetType, e[0]);
            if (info != null) {
                rowsInfo.push(info);
            }
        });
        if (rowsInfo.length == 0) return notify('Vùng đã chọn không có hàng dữ liệu nào.');

        const colsInfo = [];
        infoRowRange.values[0].forEach((e, i) => {
            const info = decodeColInfo(sheetType, e);
            if (info != null) {
                const colItem = (sheetType == SHEET_TYPE.TONG_HOP ? {
                    colIdx: i,
                    isSynthetic: true,
                    dataType: info.dataType,
                    globalPlan: (typeof info.globalPlan == 'object' ? info.globalPlan.value : info.globalPlan),
                    division: (typeof info.division == 'object' ? info.division.value : info.division),
                    project: (typeof info.project == 'object' ? info.project.value : info.project),
                    beginDate: info.beginDate.format('YYYYMMDD'),
                    endDate: info.endDate.format('YYYYMMDD')
                } : {
                    colIdx: i,
                    isSynthetic: false,
                    dataType: sheetType,
                    globalPlan: planId,
                    division: (typeof info.division == 'object' ? info.division.value : info.division),
                    project: (typeof info.project == 'object' ? info.project.value : info.project),
                    date: info.date.format('YYYYMMDD')
                });

                colsInfo.push(colItem);
            }
        });
        if (colsInfo.length == 0) return notify('Vùng đã chọn không có cột dữ liệu nào.');

        kajax({
            method: 'post',
            url: _UrlBase + '/excel/pull/data',
            data: {
                colsInfo
            }
        }, retData => {
            processPullData(sheetType, sheetTransposed, planId, retData, rowIndex, columnIndex, rowCount, columnCount, showDiffDlg);
        });

    }).catch(err => {
        console.log(err);
        notify('Lỗi đọc dữ liệu bảng.')
    });
}



async function commitData(sheetType, sheetTransposed, planId, rowIndex, columnIndex, rowCount, columnCount) {
    const specialCols = await requireSpecialColumns([SPECIAL_COLUMN.INFO.value]);
    if (!specialCols) return;

    const {projectStructure} = await getGeneralInfo(['projectStructure'], true);

    Excel.run(async context => {
        const worksheet = context.workbook.worksheets.getActiveWorksheet();
        const infoRowRange = getRangeByIndexes(worksheet, 0, columnIndex, 1, columnCount).load('values');
        const infoColRange = getRangeByIndexes(worksheet, rowIndex, specialCols[SPECIAL_COLUMN.INFO.value], rowCount, 1).load('values');
        const valueRange = getRangeByIndexes(worksheet, rowIndex, columnIndex, rowCount, columnCount).load('values');
        await context.sync();

        const colsData = [];
        for (let colIdx = 0; colIdx < columnCount; colIdx++) {
            const info = decodeColInfo(sheetType, infoRowRange.values[0][colIdx]);
            if (!info) continue;
            if (typeof info.division == 'object' || typeof info.project == 'object') continue;

            colsData.push({
                colIdx,
                dataType: sheetType,
                division: info.division,
                project: info.project,
                globalPlan: planId,
                date: info.date.format('YYYYMMDD'),
                data: []
            });
        }

        if (colsData.length == 0) return notify('Vùng chọn không có cột dữ liệu nhập nào.');

        const userInputValueTypeCode = valueTypeName2Code(DATA_ITEM_VALUE_TYPE.USER_INPUT);
        for (let i = 0; i < rowCount; i++) {
            const info = decodeRowInfo(sheetType, infoColRange.values[i][0]);
            if (!info) continue;

            const structureItem = projectStructure.find(e => e.id == info.id);
            if (!structureItem || valueTypeName2Code(structureItem.value_type) != userInputValueTypeCode) continue;

            colsData.forEach(col => {
                col.data.push({
                    id: info.id,
                    value: valueRange.values[i][col.colIdx]
                });
            });
        }

        if (colsData[0].data.length == 0) return notify('Vùng chọn không có hàng dữ liệu nhập nào.');

        kajax({
            method: 'post',
            url: _UrlBase + '/excel/commit/data',
            data: {
                colsData
            }
        }, retData => {
            const noPermittedCols = retData.reduce((accu, e) => (e.status ? accu : accu + 1), 0);
            notify(`Đã lưu dữ liệu (${colsData[0].data.length} hàng × ${colsData.length} cột${noPermittedCols == 0 ? '' : `, ${noPermittedCols} cột không có quyền`}).`);
        })
    }).catch(err => {
        console.log(err);
        notify('Lỗi đọc dữ liệu bảng.')
    });
}


async function OnInitSheet() {
    const {sheetType} = await getSheetInfo();
    if (sheetType != null) return notify('Trang tính đã được khởi tạo. Hãy mở trang tính khác.');

    const {globalPlans} = await getGeneralInfo(['globalPlans'], true);

    Excel.run(async context => {
        const worksheet = context.workbook.worksheets.getActiveWorksheet();

        const usedRange = worksheet.getUsedRangeOrNullObject();
        await context.sync();

        const sheetHasData = !usedRange.isNullObject;

        const dlg = showPaneDialog({
            title: 'Khởi tạo trang tính',
            content: `<div class="mb-3">
                    <label class="form-label" for="modal--sheet-type">Loại trang tính:</label>
                    <select class="form-select" id="modal--sheet-type">
                        <optgroup label="Nhập dữ liệu">
                            ${USER_PERMISSIONS.includes('perm_ky_thuat') ? `<option value="${SHEET_TYPE.KE_HOACH}">Bảng dữ liệu kế hoạch</option>` : ''}
                            ${USER_PERMISSIONS.includes('perm_phan_xuong') ? `<option value="${SHEET_TYPE.THUC_HIEN}">Bảng dữ liệu thực hiện</option>` : ''}
                            ${USER_PERMISSIONS.includes('perm_kcs') ? `<option value="${SHEET_TYPE.KIEM_TRA_KCS}">Bảng dữ liệu kiểm tra KCS</option>` : ''}
                            ${USER_PERMISSIONS.includes('perm_ky_thuat') ? `<option value="${SHEET_TYPE.KIEM_TRA_KY_THUAT}">Bảng dữ liệu kiểm tra kỹ thuật</option>` : ''}
                        </optgroup>

                        ${USER_PERMISSIONS.includes('perm_ky_thuat') ? `<optgroup label="Tổng hợp">
                            <option value="${SHEET_TYPE.TONG_HOP}">Bảng báo cáo tổng hợp</option>
                        </optgroup>` : '' }

                        ${USER_PERMISSIONS.includes('perm_ky_thuat') ? `<optgroup label="Quản trị">
                            <option value="${SHEET_TYPE.CAU_TRUC_BANG}">Cấu trúc bảng chỉ tiêu</option>
                        </optgroup>` : '' }
                    </select>
                </div>
                
                <div class="mb-3 d-none">
                    <label class="form-label" for="modal--global-plan">Kế hoạch:</label>
                    <select class="form-select" id="modal--global-plan">
                        ${globalPlans2SelectOptions(globalPlans, null)}
                    </select>
                </div>
                
                <div class="mb-3">
                    <label class="form-label" for="modal--init-structure">Khởi tạo cấu trúc:</label>
                    <select class="form-select" id="modal--init-structure">
                        <option value="table">Tạo bảng chỉ tiêu</option>
                        <option value="info">Tạo hàng và cột thông tin</option>
                        <option value="no">Giữ nguyên bảng</option>
                    </select>

                    ${sheetHasData ? `<div class="alert alert-warning mt-1 p-1 small" id="modal--init-structure-warning">Trang tính đã có dữ liệu. Tạo bảng chỉ tiêu sẽ khiến dữ liệu bị xoá mất.</div>` : ''}
                </div>`,
                
                //<div class="mb-3">
                //    <input type="checkbox" class="form-check-input" id="modal--sheet-transposed">
                //    <label class="form-check-label" for="modal--sheet-transposed">Xoay ngang bảng</label>
                //</div>`,
            onOk: () => {
                const sheetType = dataTypeSel.val();
                const sheetTransposed = false; // sheetTransposedChk.is(':checked');
                const planId = (sheetType == SHEET_TYPE.KE_HOACH ? globalPlanSel.val() : null);
                const initStructure = initStructureSel.val();

                if (sheetType == null) return notify('Chưa chọn loại trang tính.');
                if (sheetType == SHEET_TYPE.KE_HOACH && planId == null) return notify('Chưa chọn kế hoạch.');

                dlg.modal.hide();

                initSheet(sheetType, sheetTransposed, planId, initStructure);
            }
        });

        const dataTypeSel = dlg.dom.find('#modal--sheet-type');
        const globalPlanSel = dlg.dom.find('#modal--global-plan');
        const initStructureSel = dlg.dom.find('#modal--init-structure');
        const sheetTransposedChk = dlg.dom.find('#modal--sheet-transposed');

        const onDataTypeChange = () => {
            globalPlanSel.parent().toggleClass('d-none', dataTypeSel.val() != SHEET_TYPE.KE_HOACH);
        };
        onDataTypeChange();
        dataTypeSel.change(onDataTypeChange);

        if (sheetHasData) {
            const onInitStructureChange = () => {
                dlg.dom.find('#modal--init-structure-warning').toggleClass('d-none', initStructureSel.val() != 'table');
            };
            onInitStructureChange();
            initStructureSel.change(onInitStructureChange);
        }
    });
}


async function initColumns(context, sheetType, sheetTransposed, planId, dataType, globalPlan, usedRangeProps, selRangeProps, generalInfo) {
    const worksheet = context.workbook.worksheets.getActiveWorksheet();

    const infoRowRange = getRangeByIndexes(worksheet, 0, selRangeProps.columnIndex, 1, selRangeProps.columnCount).load('values');
    await context.sync();

    let initInfo = null;
    for (let i = 0; i < selRangeProps.columnCount; i++) {
        const v = infoRowRange.values[0][i];
        if (Object.values(SPECIAL_COLUMN).find(e => e.value == v)) return notify('Vùng đã chọn có chứa cột dành riêng được bảo vệ.')
        initInfo = decodeColInfo(sheetType, v);
        if (initInfo) break;
    }
    
    const monthDate = (dataType == DATA_GROUP_TYPES.KE_HOACH);
    const dateFormat = (monthDate ? 'MM/YYYY' : 'DD/MM/YYYY');

    const dlg = showPaneDialog({
        title: 'Khởi tạo cột dữ liệu',
        content: `<div class="mb-3">
                <label class="form-label" for="modal--division">Đơn vị:</label>
                <select class="form-select" id="modal--division">
                    ${SPECIAL_DIVISION_INFO.map(e => `<option value="${e.id}" ${initInfo && initInfo.division == e.id ? 'selected' : ''}>(${e.name})</option>`).join('')}
                    ${generalInfo.divisions.map(e => `<option value="${e.id}" ${initInfo && initInfo.division == e.id ? 'selected' : ''}>${e.name}</option>`).join('')}
                </select>
            </div>
            
            <div class="mb-3">
                <label class="form-label" for="modal--project">Công trình:</label>
                <select class="form-select" id="modal--project">
                    ${SPECIAL_PROJECT_INFO.map(e => `<option value="${e.id}" ${initInfo && initInfo.division == e.id ? 'selected' : ''}>(${e.name})</option>`).join('')}
                    ${projects2SelectOptions(generalInfo.projects, initInfo ? initInfo.project : null)}
                </select>
            </div>
            
            ${sheetType == SHEET_TYPE.TONG_HOP ? `<div class="mb-3">
                <label class="form-label" for="modal--begin-date">Thời gian bắt đầu (${monthDate ? 'tháng' : 'ngày'}):</label>
                <input type="text" class="form-control" id="modal--begin-date" data-provide="datepicker" data-date-type="${monthDate ? 'month' : 'day'}"
                    value="${(initInfo ? initInfo.beginDate : moment()).format(dateFormat)}" autocomplete="off" />
            </div>

            <div class="mb-3">
                <label class="form-label" for="modal--end-date">Thời gian kết thúc (${monthDate ? 'tháng' : 'ngày'}):</label>
                <input type="text" class="form-control" id="modal--end-date" data-provide="datepicker" data-date-type="${monthDate ? 'month' : 'day'}"
                    value="${(initInfo ? initInfo.endDate : moment()).format(dateFormat)}" autocomplete="off" />
            </div>` :

            `<div class="mb-3">
                <label class="form-label" for="modal--date">Thời gian (${monthDate ? 'tháng' : 'ngày'}):</label>
                <input type="text" class="form-control" id="modal--date" data-provide="datepicker" data-date-type="${monthDate ? 'month' : 'day'}"
                    value="${(initInfo ? initInfo.date : moment()).format(dateFormat)}" autocomplete="off" />
            </div>`}
            
            ${selRangeProps.columnCount == 1 ? '' : `<div class="mb-3">
                <label class="form-label" for="modal--date-interval">Khoảng cách thời gian (${monthDate ? 'tháng' : 'ngày'}):</label>
                <input type="number" class="form-control" id="modal--date-interval" value="1" min="1" />
            </div>`}
            
            <div class="mb-3">
                <label class="form-label" for="modal--update-data">Cập nhật dữ liệu:</label>
                <select class="form-select" id="modal--update-data">
                    <option value="no">Không cập nhật</option>
                    <option value="all">Toàn bộ các cột</option>
                    <option value="selection">Chỉ các hàng được chọn</option>
                </select>
            </div>`,
        onOk: () => {
            const project = dlg.dom.find('#modal--project').val();
            const division = dlg.dom.find('#modal--division').val();
            const dateInterval = parseInt(dlg.dom.find('#modal--date-interval').val());
            const updateData = dlg.dom.find('#modal--update-data').val();
            let date, beginDate, endDate;

            if (project == null) return notify('Chưa chọn công trình.');
            if (division == null) return notify('Chưa chọn đơn vị.');
            if (selRangeProps.columnCount > 1 && (dateInterval == 0 || isNaN(dateInterval))) return notify('Chưa xác định khoảng cách thời gian.');

            if (sheetType == SHEET_TYPE.TONG_HOP) {
                beginDate = moment(dlg.dom.find('#modal--begin-date').val(), dateFormat);
                endDate = moment(dlg.dom.find('#modal--end-date').val(), dateFormat);
                if (!beginDate.isValid()) return notify('Chưa nhập thời gian bắt đầu.');
                if (!endDate.isValid()) return notify('Chưa nhập thời gian kết thúc.');

                if (monthDate) {
                    beginDate.date(1);
                    endDate.date(1);
                }
            } else {
                date = moment(dlg.dom.find('#modal--date').val(), dateFormat);
                if (!date.isValid()) return notify('Chưa nhập thời gian.');

                if (monthDate) date.date(1);
            }

            dlg.modal.hide();

            Excel.run(async context => {
                const worksheet = context.workbook.worksheets.getActiveWorksheet();
                const infoRowRange = getRangeByIndexes(worksheet, 0, selRangeProps.columnIndex, 1, selRangeProps.columnCount);

                infoRowRange.values = [Array(selRangeProps.columnCount).fill(0).map((e, i) => {
                    const info = {division, project};
                    if (sheetType == SHEET_TYPE.TONG_HOP) {
                        info.dataType = dataType;
                        info.globalPlan = globalPlan;

                        const bdi = beginDate.clone().add(dateInterval * i, monthDate ? 'M' : 'd');
                        const edi = endDate.clone().add(dateInterval * i, monthDate ? 'M' : 'd');
                        info.beginDate = bdi.format('YYYYMMDD');
                        info.endDate = edi.format('YYYYMMDD');
                    } else {
                        const di = date.clone().add(dateInterval * i, monthDate ? 'M' : 'd');
                        info.date = di.format('YYYYMMDD');
                    }

                    return encodeColInfo(sheetType, info);
                })];
                await context.sync();

                await formatSheet(true, false);

                if (updateData == 'all' || (updateData == 'selection' && selRangeProps.isEntireColumn))
                    await pullData(sheetType, sheetTransposed, planId, usedRangeProps.rowIndex, selRangeProps.columnIndex, usedRangeProps.rowCount, selRangeProps.columnCount, false);
                else if (updateData == 'selection')
                    await pullData(sheetType, sheetTransposed, planId, selRangeProps.rowIndex, selRangeProps.columnIndex, selRangeProps.rowCount, selRangeProps.columnCount, false);

                notify(`Đã gán thông tin cho ${selRangeProps.columnCount} cột.`)
                updateInfoBar();

            }).catch(err => {
                console.log(err);
                notify('Lỗi: Không gán được thông tin cột.');
            });
        }
    });

    dlg.dom.find('input[data-provide="datepicker"]').datepicker({
        autoclose: true,
        assumeNearbyYear: true,
        format: monthDate ? 'mm/yyyy' : 'dd/mm/yyyy',
        language: "vi",
        orientation: "bottom",
        todayHighlight: true,
        disableTouchKeyboard: true,
        minViewMode: monthDate ? 1 : 0,
        zIndexOffset: 1000
    });    
}

async function OnInitColumns() {
    const {sheetType, sheetTransposed, planId} = await getSheetInfo();
    if (sheetType == null) return notify('Trang tính chưa được khởi tạo.');
    if (sheetType == SHEET_TYPE.CAU_TRUC_BANG) return notify('Tác vụ không hoạt động với bảng cấu trúc.');

    Excel.run(async context => {
        const worksheet = context.workbook.worksheets.getActiveWorksheet();
        const selRange = context.workbook.getSelectedRange().load('rowIndex, columnIndex, rowCount, columnCount, isEntireRow, isEntireColumn');
        const usedRange = worksheet.getUsedRange().load('rowIndex, rowCount');
        await context.sync();

        if (selRange.isEntireRow) return notify('Tác vụ không thực hiện khi chọn cả hàng.');

        const generalInfo = await getGeneralInfo(['divisions', 'projects', 'globalPlans'], true);

        const selRangeProps = pickObjProps(selRange, ['rowIndex', 'columnIndex', 'rowCount', 'columnCount', 'isEntireRow', 'isEntireColumn']);
        const usedRangeProps = pickObjProps(usedRange, ['rowIndex', 'rowCount']);
        if (sheetType != SHEET_TYPE.TONG_HOP) return initColumns(context, sheetType, sheetTransposed, planId, sheetType, null, usedRangeProps, selRangeProps, generalInfo);

        const dlg = showPaneDialog({
            title: 'Khởi tạo cột',
            content: `<div class="mb-3">
                    <label class="form-label" for="modal--sheet-data-type">Loại dữ liệu cột:</label>
                    <select class="form-select" id="modal--data-type">
                        ${USER_PERMISSIONS.includes('perm_ky_thuat') ? `<option value="${DATA_GROUP_TYPES.KE_HOACH}">Dữ liệu kế hoạch</option>` : ''}
                        ${USER_PERMISSIONS.includes('perm_phan_xuong') ? `<option value="${DATA_GROUP_TYPES.THUC_HIEN}">Dữ liệu thực hiện</option>` : ''}
                        ${USER_PERMISSIONS.includes('perm_kcs') ? `<option value="${DATA_GROUP_TYPES.KIEM_TRA_KCS}">Dữ liệu kiểm tra KCS</option>` : ''}
                        ${USER_PERMISSIONS.includes('perm_ky_thuat') ? `<option value="${DATA_GROUP_TYPES.KIEM_TRA_KY_THUAT}">Dữ liệu kiểm tra kỹ thuật</option>` : ''}
                    </select>
                </div>
                
                <div class="mb-3 d-none">
                    <label class="form-label" for="modal--global-plan">Kế hoạch:</label>
                    <select class="form-select" id="modal--global-plan">
                        ${globalPlans2SelectOptions(generalInfo.globalPlans, null)}
                    </select>
                </div>`,
            onOk: () => {
                const dataType = dataTypeSel.val();
                const planId = (dataType == DATA_GROUP_TYPES.KE_HOACH ? globalPlanSel.val() : null);

                if (dataType == null) return notify('Chưa chọn loại dữ liệu.');
                if (dataType == DATA_GROUP_TYPES.KE_HOACH && planId == null) return notify('Chưa chọn kế hoạch.');

                dlg.modal.hide();

                Excel.run(async context => {
                    initColumns(context, sheetType, dataType, planId, usedRangeProps, selRangeProps, generalInfo);
                });
            }
        });

        const dataTypeSel = dlg.dom.find('#modal--data-type');
        const globalPlanSel = dlg.dom.find('#modal--global-plan');

        const onDataTypeChange = () => {
            globalPlanSel.parent().toggleClass('d-none', dataTypeSel.val() != DATA_GROUP_TYPES.KE_HOACH);
        };
        onDataTypeChange();
        dataTypeSel.change(onDataTypeChange);

    }).catch(err => {
        console.log(err)
        notify('Lỗi: Hãy chọn cột cần khởi tạo.')
    });
}



async function OnRemoveColumns() {
    const {sheetType} = await getSheetInfo();
    if (sheetType == null) return notify('Trang tính chưa được khởi tạo.');
    if (sheetType == SHEET_TYPE.CAU_TRUC_BANG) return notify('Tác vụ không hoạt động với bảng cấu trúc.');

    Excel.run(async context => {
        const worksheet = context.workbook.worksheets.getActiveWorksheet();
        const selRange = context.workbook.getSelectedRange().load('columnIndex, columnCount, isEntireRow, values');
        await context.sync();

        if (selRange.isEntireRow) return notify('Tác vụ không hoạt động khi chọn toàn bộ hàng.');

        const {columnIndex, columnCount} = selRange;
        const infoRowRange = getRangeByIndexes(worksheet, 0, columnIndex, 1, columnCount).load('values');
        await context.sync();

        if (infoRowRange.values[0].some(info => Object.values(SPECIAL_COLUMN).findIndex(e => e.value == info) >= 0))
            return notify('Vùng đã chọn có chứa cột dành riêng được bảo vệ.');
        
        infoRowRange.values = [Array(columnCount).fill('')];
        await context.sync();

        updateInfoBar();

    }).catch(err => {
        console.log(err)
        notify('Lỗi: Hãy chọn các cột cần gỡ thông tin.')
    });
}



async function OnInitRows() {
    const {sheetType} = await getSheetInfo();
    if (sheetType == null) return notify('Trang tính chưa được khởi tạo.');

    const specialCols = await requireSpecialColumns(
        [SPECIAL_COLUMN.INFO.value],
        [SPECIAL_COLUMN.ITEM_LEVEL, SPECIAL_COLUMN.ITEM_NAME, SPECIAL_COLUMN.ITEM_UNIT, SPECIAL_COLUMN.ITEM_VALUE_TYPE].map(e => e.value));
    if (!specialCols) return;

    Excel.run(async context => {
        const worksheet = context.workbook.worksheets.getActiveWorksheet();
        const selRange = context.workbook.getSelectedRange().load('rowIndex, rowCount, values');
        const wholerange = worksheet.getUsedRange().load('rowIndex, rowCount');
        await context.sync();

        if (selRange.rowCount > 1) return notify('Tác vụ chỉ thực hiện với một hàng chọn.');
        if (selRange.rowIndex == 0) return notify('Vùng đã chọn có chứa hàng dành riêng được bảo vệ.')

        const selRowIndex = selRange.rowIndex;
        const selRowRange = getRangeByIndexes(worksheet, selRowIndex, specialCols[SPECIAL_COLUMN.INFO.value], 1, 1).load('values');
        const infoColRange = getRangeByIndexes(worksheet, 0, specialCols[SPECIAL_COLUMN.INFO.value], wholerange.rowIndex + wholerange.rowCount, 1).load('values');
        await context.sync();

        const selRowInfo = decodeRowInfo(sheetType, selRowRange.values[0][0]);

        const idsInUse = [];
        infoColRange.values.forEach((e, i) => {
            if (i == selRowIndex) return; // skip the selected row

            const info = decodeRowInfo(sheetType, e[0]);
            if (info != null) idsInUse.push(info.id);
        });

        const {projectStructure} = await getGeneralInfo(['projectStructure'], true);
        const structureActive = projectStructure.filter(e => !e.removed);
        const structureRemoved = projectStructure.filter(e => e.removed);

        const dlg = showPaneDialog({
            title: 'Khởi tạo hàng',
            content: `<div class="mb-3">
                    <label class="form-label" for="modal--item">Chọn chỉ tiêu:</label>
                    <select class="form-select" id="modal--item" size="13">
                        <optgroup label="Hiện hành">
                            ${structureActive.length == 0 ? '<option disabled>(Không có)</option>' :
                            structureActive.map(e => {
                                let html = '<option';

                                if (idsInUse.includes(+e.id)) html += ' class="text-secondary" disabled';
                                else html += ` value="${e.id}" ${selRowInfo && e.id == selRowInfo.id ? 'selected' : ''} class="text-success"`;

                                return html + ` style="padding-left:${(e.level-1)*0.5}rem">${e.name}</option>`;
                            }).join('')}
                        </optgroup>

                        <optgroup label="Đã loại bỏ">
                            ${structureRemoved.length == 0 ? '<option disabled>(Không có)</option>' :
                            structureRemoved.map(e => {
                                let html = '<option';

                                if (idsInUse.includes(+e.id)) html += ' class="text-secondary" disabled';
                                else html += ` value="${e.id}" ${selRowInfo && e.id == selRowInfo.id ? 'selected' : ''} class="text-danger"`;
                                
                                return html + ` style="padding-left:${(e.level-1)*0.5}rem">${e.name}</option>`;
                            }).join('')}
                        </optgroup>
                    </select>

                    <div class="small mt-1">
                        <div class="text-success">Chỉ tiêu hiện hành chưa sử dụng trong bảng.</div>
                        <div class="text-secondary">Chỉ tiêu hiện hành đã sử dụng trong bảng.</div>
                        <div class="text-danger">Chỉ tiêu đã được loại bỏ.</div>
                    </div>
                </div>`,
            onOk: () => {
                const itemId = itemSel.val();
                if (itemId == null) return notify('Chưa chọn chỉ tiêu.');

                dlg.modal.hide();

                Excel.run(async context => {
                    const worksheet = context.workbook.worksheets.getActiveWorksheet();
                    const item = projectStructure.find(e => e.id == itemId);
                    if (specialCols[SPECIAL_COLUMN.INFO.value] != null) getRangeByIndexes(worksheet, selRowIndex, specialCols[SPECIAL_COLUMN.INFO.value], 1, 1).values = [[encodeRowInfo(sheetType, item)]];
                    if (specialCols[SPECIAL_COLUMN.ITEM_NAME.value] != null) getRangeByIndexes(worksheet, selRowIndex, specialCols[SPECIAL_COLUMN.ITEM_NAME.value], 1, 1).values = [[item.name]];
                    if (specialCols[SPECIAL_COLUMN.ITEM_UNIT.value] != null) getRangeByIndexes(worksheet, selRowIndex, specialCols[SPECIAL_COLUMN.ITEM_UNIT.value], 1, 1).values = [[item.unit]];
                    if (specialCols[SPECIAL_COLUMN.ITEM_VALUE_TYPE.value] != null) getRangeByIndexes(worksheet, selRowIndex, specialCols[SPECIAL_COLUMN.ITEM_VALUE_TYPE.value], 1, 1).values = [[item.value_type]];
                    await context.sync();

                    formatSheet(true, false);
                    notify('Đã gán thông tin cho hàng.')
                }).catch(err => {
                    console.log(err);
                    notify('Lỗi: Không gán được thông tin hàng.')
                });
            }
        });

        const itemSel = dlg.dom.find('#modal--item');
        dlg.dom.on('shown.bs.modal', evt => {
            const sel = itemSel.find('option:selected');
            if (sel.length > 0) itemSel.scrollTop(sel.offset().top - itemSel.offset().top - 50);
        });

    }).catch(err => {
        console.log(err);
        notify('Lỗi đọc dữ liệu bảng.')
    });
}



async function OnRemoveRows() {
    const {sheetType} = await getSheetInfo();
    if (sheetType == null) return notify('Trang tính chưa được khởi tạo.');

    const specialCols = await requireSpecialColumns([SPECIAL_COLUMN.INFO.value]);
    if (!specialCols) return;

    Excel.run(async context => {
        const worksheet = context.workbook.worksheets.getActiveWorksheet();
        const selRange = context.workbook.getSelectedRange().load('rowIndex, rowCount, isEntireColumn');
        await context.sync();

        if (selRange.isEntireColumn) return notify('Tác vụ không hoạt động khi chọn tất cả các hàng.');
        if (selRange.rowIndex == 0) return notify('Vùng đã chọn có chứa hàng dành riêng được bảo vệ.');
        
        const {rowIndex, rowCount} = selRange;
        const infoColRange = getRangeByIndexes(worksheet, rowIndex, specialCols[SPECIAL_COLUMN.INFO.value], rowCount, 1).load('values');
        await context.sync();

        if (infoColRange.values.some(e => e[0] == IGNORED_ROW_VALUE)) return notify('Vùng đã chọn có chứa hàng dành riêng được bảo vệ.');

        infoColRange.values = Array(rowCount).fill(['']);
        await context.sync();

        updateInfoBar();

    }).catch(err => {
        console.log(err)
        notify('Lỗi: Hãy chọn các hàng cần gỡ thông tin.')
    });
}




async function OnCommitStructure() {
    const {sheetType} = await getSheetInfo();
    if (sheetType == null) return notify('Trang tính chưa được khởi tạo.');
    if (sheetType != SHEET_TYPE.CAU_TRUC_BANG) return notify('Tác vụ chỉ hoạt động với bảng cấu trúc.');

    const specialCols = await requireSpecialColumns();
    if (!specialCols) return;

    Excel.run(async context => {
        const worksheet = context.workbook.worksheets.getActiveWorksheet();
        const wholerange = worksheet.getUsedRange().load('columnIndex, columnCount, values');
        await context.sync();

        const structure = [];
        let hasError = false;
        let hasUpdates = false;
        wholerange.values.forEach((row, i) => {
            if (i == 0 || row[0] == IGNORED_ROW_VALUE) return;

            const rowInf = decodeRowInfo(sheetType, row[specialCols[SPECIAL_COLUMN.INFO.value]]);
            const value_type_code__in_sheet = valueTypeName2Code(row[specialCols[SPECIAL_COLUMN.ITEM_VALUE_TYPE.value]]);

            // if value_type column has been changed, update the info column
            if (rowInf && rowInf.value_type_code != value_type_code__in_sheet) {
                console.log(rowInf)
                rowInf.value_type = valueTypeCode2Name(value_type_code__in_sheet);
                rowInf.value_type_code = value_type_code__in_sheet;
                getRangeByIndexes(worksheet, i, specialCols[SPECIAL_COLUMN.INFO.value], 1, 1).values = [[encodeRowInfo(sheetType, rowInf)]];
                hasUpdates = true;
            }

            const item = {
                id: rowInf == null ? null : rowInf.id,
                localId: rowInf == null ? i : null,
                name: row[specialCols[SPECIAL_COLUMN.ITEM_NAME.value]],
                unit: row[specialCols[SPECIAL_COLUMN.ITEM_UNIT.value]],
                value_type: row[specialCols[SPECIAL_COLUMN.ITEM_VALUE_TYPE.value]],
                level: rowInf == null ? (structure.length > 0 ? structure[structure.length - 1].level : 1) : rowInf.level
            }

            if (item.id == null && !item.name) return true;

            if (!hasError && (!item.name || !item.value_type)) {
                getRangeByIndexes(worksheet, i, wholerange.columnIndex, 1, wholerange.columnCount).select();
                hasError = true;
                hasUpdates = true;
                return;
            }

            structure.push(item);
        });
        
        if (hasUpdates) context.sync();
        if (hasError) return notify('Thông tin chỉ tiêu chưa đầy đủ.');

        const newItems = structure.filter(e => e.id === null);
        let ignoredItems = null;
        if (newItems.length > 0) {
            const unselected = await new Promise(resolve => {
                const dlg = showPaneDialog({
                    title: 'Cập nhật cấu trúc lên',
                    content: `<div class="mb-3">
                            <label class="form-label" for="modal--added-items">Chọn chỉ tiêu muốn bổ sung:</label>
                            <select class="form-select" id="modal--added-items" size="13" multiple>
                                ${newItems.map(e => `<option value="${e.localId}" selected>${e.name}</option>`).join('')}
                            </select>
                        </div>`,
                    onOk: () => {
                        dlg.modal.hide();

                        const unselected = [];
                        dlg.dom.find('#modal--added-items option:not(:selected)').each((i, e) => unselected.push(+$(e).val()));
                        resolve(unselected);
                    }
                });

                dlg.dom.on('hidden.bs.modal', resolve); // user cancelled
            });

            if (!unselected) return; // user cancelled

            ignoredItems = unselected;

            ignoredItems.forEach(localId => {
                const idx = structure.findIndex(row => row.localId == localId);
                if (idx >= 0) structure.splice(idx, 1);
            });
        }

        kajax({
            method: 'post',
            url: _UrlBase + '/excel/commit/structure',
            data: {
                structure
            }
        }, retData => {
            Excel.run(async context => {
                const worksheet = context.workbook.worksheets.getActiveWorksheet();

                if (ignoredItems) {
                    ignoredItems.forEach(localId => {
                        getRangeByIndexes(worksheet, localId, specialCols[SPECIAL_COLUMN.INFO.value], 1, 1).values = [[IGNORED_ROW_VALUE]];
                    });
                }

                retData.newRowsInfo.forEach(retRow => {
                    const row = structure[retRow.idx];
                    const cell = getRangeByIndexes(worksheet, row.localId, specialCols[SPECIAL_COLUMN.INFO.value], 1, 1);
                    cell.values = [[encodeRowInfo(sheetType, {id: retRow.id, level: row.level, value_type: row.value_type})]];
                });
                await context.sync();

                notify(`Đã cập nhật thành công: ${retData.newRowsInfo.length} chỉ tiêu mới, ${retData.removedRows} chỉ tiêu đã bỏ.`);
                updateInfoBar();
                formatSheet(true, false);

            }).catch(err => {
                console.log(err);
                notify('Lỗi: Không gán được thông tin hàng.');
            });
        });

    }).catch(err => {
        console.log(err);
        notify('Lỗi đọc dữ liệu bảng.');
    });
}




async function OnPullData() {
    const {sheetType, sheetTransposed, planId} = await getSheetInfo();
    if (sheetType == null) return notify('Trang tính chưa được khởi tạo.');
    if (sheetType == SHEET_TYPE.CAU_TRUC_BANG) return notify('Tác vụ không hoạt động với bảng cấu trúc.');

    Excel.run(async context => {
        const worksheet = context.workbook.worksheets.getActiveWorksheet();
        const selRange = context.workbook.getSelectedRange().load('rowIndex, columnIndex, rowCount, columnCount, isEntireRow, isEntireColumn');
        const usedRange = worksheet.getUsedRange().load('rowIndex, columnIndex, rowCount, columnCount');
        await context.sync();

        let {rowIndex, columnIndex, rowCount, columnCount, isEntireRow, isEntireColumn} = selRange;
        if (isEntireColumn) {
            rowIndex = usedRange.rowIndex;
            rowCount = usedRange.rowCount;
        }
        if (isEntireRow) {
            columnIndex = usedRange.columnIndex;
            columnCount = usedRange.columnCount;
        }

        pullData(sheetType, sheetTransposed, planId, rowIndex, columnIndex, rowCount, columnCount, true);
    }).catch(err => {
        console.log(err);
        notify('Lỗi: Không gán được dữ liệu cho bảng.')
    });
}



async function OnCommitData() {
    const {sheetType, sheetTransposed, planId} = await getSheetInfo();
    if (sheetType == null) return notify('Trang tính chưa được khởi tạo.');
    if (sheetType == SHEET_TYPE.CAU_TRUC_BANG) return notify('Tác vụ không hoạt động với bảng cấu trúc.');
    if (sheetType == SHEET_TYPE.TONG_HOP) return notify('Tác vụ không hoạt động với bảng tổng hợp.');

    Excel.run(async context => {
        const worksheet = context.workbook.worksheets.getActiveWorksheet();
        const selRange = context.workbook.getSelectedRange().load('rowIndex, columnIndex, rowCount, columnCount, isEntireRow, isEntireColumn');
        const usedRange = worksheet.getUsedRange().load('rowIndex, columnIndex, rowCount, columnCount');
        await context.sync();

        let {rowIndex, columnIndex, rowCount, columnCount, isEntireRow, isEntireColumn} = selRange;
        if (isEntireColumn) {
            rowIndex = usedRange.rowIndex;
            rowCount = usedRange.rowCount;
        }
        if (isEntireRow) {
            columnIndex = usedRange.columnIndex;
            columnCount = usedRange.columnCount;
        }

        commitData(sheetType, sheetTransposed, planId, rowIndex, columnIndex, rowCount, columnCount);
    }).catch(err => {
        console.log(err);
        notify('Lỗi đọc được dữ liệu bảng.')
    });
}




function checkLogin() {
    kajax({
        method: 'get',
        url: _UrlBase + '/excel/session-status'
    }, ({isLoggedIn}) => {
    if (!isLoggedIn) location.reload(true);
});
}


Office.onReady((info) => {
    if (info.host !== Office.HostType.Excel) return showBreakingError('Trang này chỉ hoạt động trong ứng dụng trên Excel.');

    if (!excelApiSupported('1.8')) return showBreakingError('Bạn cần có MS Office 2016 hoặc mới hơn để sử dụng ứng dụng này.');

    //if (navigator.userAgent.indexOf('Edg/') == -1)
    //    return showBreakingError('Xin lỗi, ứng dụng này không tương thích với phiên bản trình duyệt web bạn đang sử dụng.');

    // Auto-open
    const autoOpen = Office.context.document.settings.get("Office.AutoShowTaskpaneWithDocument")
    if( autoOpen != true){
        Office.context.document.settings.set("Office.AutoShowTaskpaneWithDocument", true); 
        Office.context.document.settings.saveAsync(); 
    }

    updateGUI();
    Excel.run(async context => {
        context.workbook.onSelectionChanged.add(updateGUI);
        await context.sync();
    });

    $('#btn-init-sheet').click(OnInitSheet);
    $('#btn-init-columns').click(OnInitColumns);
    $('#btn-remove-columns').click(OnRemoveColumns);

    $('#btn-init-rows').click(OnInitRows);
    $('#btn-remove-rows').click(OnRemoveRows);

    $('#btn-commit-structure').click(OnCommitStructure);

    $('#btn-pull-data-1, #btn-pull-data-2').click(OnPullData);
    $('#btn-commit-data').click(OnCommitData);

    $('#btn-reformat').click(OnReformatSheet);
    $('#btn-reformat-and-highlight').click(OnReformatAndHighlightSheet);

    $('#btn-indent').click(()=>{
        OnIndentation(true)
    });
    $('#btn-outdent').click(()=>{
        OnIndentation(false)
    });

    $('#btn-excel-logout').click(() => {
        $.post(_UrlBase + '/logout').done(() => {
            location = _UrlBase + '/excel';
        });
    });

    $('#btn-open-profile').click(() => {
        openUrlDlg(_UrlBase + '/profile');
    });

    // periodically make login status checking request every 10min:
    // - prevent session being expired
    // - if session is expired, ask the user to re-login
    setInterval(checkLogin, 10*60*1000);
})

