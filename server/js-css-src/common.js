

window.replaceContent = function(container, HTML, animated, callback) {
	var obj = $(container);

	if (animated && obj.is(":animated"))
		obj.finish();
	
	var oldHeight = obj.height();
	obj.html(HTML);
	var newHeight = obj.height();
	
	if (animated && oldHeight != newHeight) {
		obj.height(oldHeight);
		obj.animate({height: newHeight}, 'fast', function() {
			obj.height('auto');
			if (callback != undefined) callback();
		});
	}
}

window.RelURL2Abs = function(url) {
	return window.location.protocol + '//' + window.location.hostname + url;
}


window.MakeAlwaysVisible = function(obj, alignTop) {
	if (alignTop == undefined) alignTop = true;
	
	var obj = $(obj);
	if (obj.length == 0) return;
	
	var oldWidth = obj.css('width'),
		wnd = $(window);
	var scrollFunc = function () {
		var headbar = $('.navbar'),
			normalTop = obj.parent().offset().top,
			topLimit = alignTop ? (headbar.offset().top + headbar.outerHeight() + 5)
								: (wnd.scrollTop() + wnd.height() - obj.outerHeight() - 5);
			
		if (normalTop <= topLimit) {
			var bottomLimit = $('#footer-separator').offset().top - obj.outerHeight();
			obj.css({
				'position': 'fixed',
				'top': Math.min(topLimit, bottomLimit) - wnd.scrollTop() + 'px',
				'width': obj.width() + 'px'
			});
		} else {
			obj.css({
				'position': 'absolute',
				'top': '',
				'width': oldWidth
			});
		}
	};
	
	scrollFunc();
	wnd.scroll(scrollFunc);
}

window.ScrollTo = function(y) {
	$("html,body").animate({ scrollTop: y }, '1000');
}

window.OnAnchorScroll = function(link, event) {
	event.preventDefault();

	var href = $(link).attr('href');
	ScrollTo($(href).offset().top);

	if (history.pushState)
		history.pushState(null, null, href);
}



///////////////////////////////////////////////////////////////////
// Cookie

window.setCookie = function(c_name, value, exdays) {
	var exdate = new Date();
	exdate.setDate(exdate.getDate() + exdays);
	
	var c_value=escape(value);
	if (exdays!=null) c_value += "; expires=" + exdate.toUTCString();
	c_value += "; path=/";
	document.cookie = c_name + "=" + c_value;
}

window.getCookie = function(c_name) {
	var c_value = document.cookie;
	var c_start = c_value.indexOf(" " + c_name + "=");

	if (c_start == -1)
		c_start = c_value.indexOf(c_name + "=");

	if (c_start == -1) c_value = null;
	else {
		c_start = c_value.indexOf("=", c_start) + 1;
		var c_end = c_value.indexOf(";", c_start);
		if (c_end == -1)
			c_end = c_value.length;
		c_value = unescape(c_value.substring(c_start,c_end));
	}
	return c_value;
}

/* Options
opt.always:		Always shown even when other notifications are visible (default: true)
opt.cookie:		Cookie (default: not applied)
opt.action:		Action button title (default: not applied)
opt.close:		Close button title (default: not applied)
opt.dismiss:	Dismiss button title (default: not applied)
opt.callback:	Callback function (default: not applied)
opt.autoDismiss: Auto dismissing after a short time (default: true)
*/
window.notify = function(msg, opt) {
	opt = opt ? opt : {};
	
	if (typeof opt.cookie === 'string' && getCookie(opt.cookie) == 0) return;
	if (opt.always === false && $('.notification').length > 0) return;

	// hide other notifications if existing
	$('.notification:visible').fadeOut('fast');
	
	var numBtns = 0, btnHtml = '';
	if (typeof opt.action === 'string') {
		btnHtml += '<button class="noti-action">' + opt.action + '</button>';
		numBtns++;
	}
	if (typeof opt.close === 'string') {
		btnHtml += '<button class="noti-close">' + opt.close + '</button>';
		numBtns++;
	}
	if (typeof opt.dismiss === 'string') {
		btnHtml += '<button class="noti-dismiss">' + opt.dismiss + '</button>';
		numBtns++;
	}

	var html = '<div class="notification">' +
					'<div class="noti-container">' +
						'<div class="noti-actions">' + btnHtml + '</div>' +
						'<p class="noti-message">' + msg;
	for (var i = 0; i < numBtns; i++)
		html += '<div class="noti-dummy-btn"></div>';
	html += '</p>' +
			'</div>' +
			'</div>';
	var obj = $(html);
	obj.appendTo('body');

	
	var actionFunc = function(actionName) {
		obj.fadeOut('fast', function() {
			obj.remove();
			$('.notification').last().fadeIn('fast');
		});
		
		if (typeof opt.cookie === 'string') {
			if (actionName == 'close') setCookie(opt.cookie, 0, 1);	// 1 day to expire
			else if (actionName == 'dismiss') setCookie(opt.cookie, 0, 10*365);	// 10 years to expire
		}
		
		if (typeof opt.callback === 'function')
			opt.callback(actionName);
	};
	
	obj.find('button.noti-action').click(function() {
		actionFunc('action');
	});
	obj.find('button.noti-close').click(function() {
		actionFunc('close');
	});
	obj.find('button.noti-dismiss').click(function() {
		actionFunc('dismiss');
	});
	
	if (opt.autoDismiss !== false) {
		setTimeout(function() {
			actionFunc('dismiss');
		}, 5000);
	}
	
	return obj;
}



window.kajax = function(inf, success, error) {
	if (inf.type === undefined && inf.method === undefined) inf.type = 'post';
	
	inf.dataType = 'json';
	inf.contentType = 'application/json';
	inf.data = JSON.stringify(inf.data);
	
	inf.success = function(ret) {
		if (ret.msg == 'OK') success(ret.data);
		else {
			if (error != undefined) error(ret.msg);
			notify('Lỗi: ' + ret.msg);
		}
	};
	
	inf.error = function() {
		if (error != undefined) error(null);
		notify("Lỗi");
	};
	
	return $.ajax(inf);
}



window.ConfirmDialog = function(message, handler) {
	const dom = $(`<div class="modal fade" tabindex="-1" id="confirmModal" role="dialog">
		<div class="modal-dialog">
			<div class="modal-content">
				<div class="modal-header">
					<h5 class="modal-title">Xác nhận</h5>
					<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
				</div>
				<div class="modal-body">
					<p>${message}</p>
				</div>
				<div class="modal-footer">
					<button type="button" class="btn btn-primary btn-yes">Đồng ý</button>
					<button type="button" class="btn btn-secondary btn-no">Không đồng ý</button>
				</div>
			</div>
		</div>
	</div>`);
	
	const modal = new bootstrap.Modal(dom[0], {
		backdrop: 'static',
		keyboard: true
	});

	dom.on('shown.bs.modal', () => dom.find('.modal-body').find('select, input, textarea, button').first().focus());

	dom.find('.btn-yes').click(() => {
		handler(true);
		modal.hide();
	});

	dom.find('.btn-no').click(() => {
		handler(false);
		modal.hide();
	});

	modal.show();
	return {modal, dom};
}


window.ConfirmDialogForUrl = function(message, url) {
	ConfirmDialog(message, (yes) => {
		if (!yes) return;
		$(`<form method="post" action="${url}"></form>`).appendTo('body').submit().remove();
	});
}

window.EnableTooltips = function(parentEl, options) {
	[].slice.call(parentEl.querySelectorAll('[data-bs-toggle="tooltip"]')).map(tooltipTriggerEl => new bootstrap.Tooltip(tooltipTriggerEl, options));
}


////////////////////////////////////////////////////////////////////////////////

$(function() {
	$('#login-modal').on('shown.bs.modal', () => {
		$('#login-modal input[name=username]').focus();
	});

	$('#btn-logout').click(() => {
		$.post(_UrlBase + '/logout').done(() => {
			location = _UrlBase;
		});
	});

	// Enable tooltips everywhere
	EnableTooltips(document);

	$('.previous-date, .next-date').click(function() {
		const dp = $(this).parents('.date-picker-group').find('.date-picker');

		const dateType = dp.data('date-type');
		const dateTypeInfo = {
			day: {momentFmt: 'DD/MM/YYYY', dpOprt: 'd'},
			month: {momentFmt: 'MM/YYYY', dpOprt: 'M'},
			year: {momentFmt: 'YYYY', dpOprt: 'y'}
		}[dateType];
		
		const d = moment(dp.val(), dateTypeInfo.momentFmt);
		if (d) {
			let newDate = $(this).hasClass('previous-date') ? d.subtract(1, dateTypeInfo.dpOprt) : d.add(1, dateTypeInfo.dpOprt);

			const startDate = moment(dp.datepicker('getStartDate'));
			if (startDate && newDate.isBefore(startDate)) newDate = startDate;

			const endDate = moment(dp.datepicker('getEndDate'));
			if (endDate && newDate.isAfter(endDate)) newDate = endDate;

			dp.val(newDate.format(dateTypeInfo.momentFmt)).change();
		}
	});

	$('.date-picker').each((i,e) => {
		const dateType = $(e).data('date-type');
		const dateTypeInfo = {
			day: {fmt: 'dd/mm/yyyy', mode: 0},
			month: {fmt: 'mm/yyyy', mode: 1},
			year: {fmt: 'yyyy', mode: 2},
		}[dateType];

		$(e).datepicker({
			autoclose: true,
			assumeNearbyYear: true,
			format: dateTypeInfo.fmt,
			language: 'vi',
			orientation: 'bottom',
			todayHighlight: true,
			disableTouchKeyboard: true,
			minViewMode: dateTypeInfo.mode,
			zIndexOffset: 1000
		});
	});
});

