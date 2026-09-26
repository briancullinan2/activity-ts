

import { Widget } from '@lumino/widgets';
import { Message } from '@lumino/messaging';
import type { ITimelineItem } from '../timeline/generate';

export class CalendarWidget extends Widget
{
	private _calendarGridContainer: HTMLDivElement;
	private _currentYear: number;
	private _currentMonth: number; // 1-indexed (1-12)
	private _loadedMonths: Set<string> = new Set();
	private _monthDataCache: Map<string, ITimelineItem[]> = new Map();
	private _activeCategories: Set<string> = new Set([
		'commits', 'bookmarks', 'history', 'locations', 'events'
	]);

	// Controls UI
	private _yearSelect!: HTMLSelectElement;
	private _monthSelect!: HTMLSelectElement;
	private _legendContainer!: HTMLDivElement;

	constructor()
	{
		super();
		this.addClass('jp-ActivityCalendarWidget');
		this.title.label = 'Activity Calendar';
		this.title.iconClass = 'bx bx-calendar';
		this.title.closable = true;

		const now = new Date();
		this._currentYear = now.getFullYear();
		this._currentMonth = now.getMonth() + 1;

		this.node.appendChild(this._buildHeaderToolbar());

		this._calendarGridContainer = document.createElement('div');
		this._calendarGridContainer.className = 'calendar-viewport-container';
		this.node.appendChild(this._calendarGridContainer);
	}

	protected onAfterAttach(msg: Message): void
	{
		super.onAfterAttach(msg);
		this._renderCalendarGrid();
	}

	protected onResize(msg: Widget.ResizeMessage): void
	{
		super.onResize(msg);
	}

	/**
	 * Builds and populates the 7xN CSS Grid month view
	 */
	private async _renderCalendarGrid(): Promise<void>
	{
		this._calendarGridContainer.innerHTML = '';

		// 1. Render Day Headers (Sun - Sat)
		const dayHeaders = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
		const headerRow = document.createElement('div');
		headerRow.className = 'calendar-header-row';
		dayHeaders.forEach(day =>
		{
			const cell = document.createElement('div');
			cell.className = 'calendar-header-cell';
			cell.textContent = day;
			headerRow.appendChild(cell);
		});
		this._calendarGridContainer.appendChild(headerRow);

		// 2. Build Grid Days (7 columns x N rows)
		const gridBody = document.createElement('div');
		gridBody.className = 'calendar-grid-body';

		const firstDayOfMonth = new Date(this._currentYear, this._currentMonth - 1, 1);
		const lastDayOfMonth = new Date(this._currentYear, this._currentMonth, 0);

		const startDayOfWeek = firstDayOfMonth.getDay(); // 0 (Sun) - 6 (Sat)
		const totalDaysInMonth = lastDayOfMonth.getDate();

		// Fetch primary month and adjacent tail months if necessary
		const monthKey = `${this._currentYear}-${String(this._currentMonth).padStart(2, '0')}`;
		await this._fetchMonthData(this._currentYear, this._currentMonth);

		const activeItems = (this._monthDataCache.get(monthKey) || []).filter(item =>
			this._activeCategories.has(item.category)
		);

		// Group active items by YYYY-MM-DD string key
		const itemsByDay = new Map();
		activeItems.forEach(item =>
		{
			const d = new Date(item.timestamp);
			const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
			if(!itemsByDay.has(dateStr)) itemsByDay.set(dateStr, []);
			itemsByDay.get(dateStr)!.push(item);
		});

		const todayStr = new Date().toISOString().split('T')[0];

		// Fill leading tail days from previous month
		const prevMonthLastDay = new Date(this._currentYear, this._currentMonth - 1, 0).getDate();
		for(let i = startDayOfWeek - 1; i >= 0; i--)
		{
			const dayNum = prevMonthLastDay - i;
			const cell = this._createDayCell(dayNum, true);
			gridBody.appendChild(cell);
		}

		// Fill current month days
		for(let day = 1; day <= totalDaysInMonth; day++)
		{
			const dateKey = `${this._currentYear}-${String(this._currentMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
			const dayItems = itemsByDay.get(dateKey) || [];
			const isToday = dateKey === todayStr;

			const cell = this._createDayCell(day, false, isToday, dayItems);
			gridBody.appendChild(cell);
		}

		// Fill trailing tail days to complete week grid
		const totalCellsSoFar = startDayOfWeek + totalDaysInMonth;
		const totalGridCells = Math.ceil(totalCellsSoFar / 7) * 7; // 28, 35, or 42
		for(let day = 1; day <= totalGridCells - totalCellsSoFar; day++)
		{
			const cell = this._createDayCell(day, true);
			gridBody.appendChild(cell);
		}

		this._calendarGridContainer.appendChild(gridBody);
	}
	/**
	 * Creates a single day cell in the calendar grid with auto-scaling event bars using programmatic DOM nodes.
	 */
	private _createDayCell(dayNum: number, isTailDay: boolean, isToday = false, items: ITimelineItem[] = []): HTMLDivElement
	{
		const cell = document.createElement('div');
		cell.className = `calendar-day-cell ${isTailDay ? 'tail-day' : ''}${isToday ? 'today' : ''}`;

		const dayHeader = document.createElement('div');
		dayHeader.className = 'day-number';
		dayHeader.textContent = String(dayNum);
		cell.appendChild(dayHeader);

		if(!isTailDay && items.length > 0)
		{
			const eventsContainer = document.createElement('div');
			eventsContainer.className = 'day-events-container';

			// Auto-scale event density classes based on item count
			if(items.length > 15)
			{
				eventsContainer.classList.add('density-micro'); // Shrinks down to micro pixel bars
			}
			else if(items.length > 8)
			{
				eventsContainer.classList.add('density-compact');
			}

			// Sort items chronologically by time
			items.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

			items.forEach(item =>
			{
				const eventBar = document.createElement('div');
				eventBar.className = `calendar-event-bar category-${item.category || 'default'}`;

				const d = new Date(item.timestamp);
				const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

				// 1. Construct Bar Label Nodes
				const timeSpan = document.createElement('span');
				timeSpan.className = 'event-time';
				timeSpan.textContent = timeStr;

				const titleSpan = document.createElement('span');
				titleSpan.className = 'event-title';
				titleSpan.textContent = item.title || '';

				eventBar.appendChild(timeSpan);
				eventBar.appendChild(titleSpan);

				// 2. Construct Popover Sub-Tree
				const popover = document.createElement('div');
				popover.className = 'event-popover';

				const popoverHeader = document.createElement('div');
				popoverHeader.className = 'popover-header';

				const popoverTime = document.createElement('span');
				popoverTime.className = 'popover-time';
				popoverTime.textContent = timeStr;

				const popoverCategory = document.createElement('span');
				popoverCategory.className = 'popover-category';
				popoverCategory.textContent = item.category || '';

				popoverHeader.appendChild(popoverTime);
				popoverHeader.appendChild(popoverCategory);

				const popoverTitle = document.createElement('div');
				popoverTitle.className = 'popover-title';
				popoverTitle.textContent = item.title || '';

				const popoverBody = document.createElement('div');
				popoverBody.className = 'popover-body';

				// Handle rich detail string or DOM node insertion safely
				if(item.detail)
				{
					const detailHtml = this._buildDetailPreviewHtml(item.detail);
					if(typeof detailHtml === 'string')
					{
						const parser = new DOMParser();
						const parsedDoc = parser.parseFromString(detailHtml, 'text/html');
						Array.from(parsedDoc.body.childNodes).forEach(node =>
						{
							popoverBody.appendChild(node.cloneNode(true));
						});
					}
					else if(detailHtml instanceof HTMLElement)
					{
						popoverBody.appendChild(detailHtml);
					}
				}

				popover.appendChild(popoverHeader);
				popover.appendChild(popoverTitle);
				popover.appendChild(popoverBody);

				// Append Popover to Bar Element
				eventBar.appendChild(popover);

				eventsContainer.appendChild(eventBar);
			});

			cell.appendChild(eventsContainer);
		}

		return cell;
	}


	private async _fetchMonthData(year: number, month: number): Promise<void>
	{
		const monthKey = `${year}-${String(month).padStart(2, '0')}`;
		if(this._loadedMonths.has(monthKey)) return;

		try
		{
			const response = await fetch(`/components/timeline/data/timeline-${monthKey}.json`, {
				signal: AbortSignal.timeout(15000)
			});
			if(!response.ok) return;

			const rawData: ITimelineItem[] = await response.json();
			this._monthDataCache.set(monthKey, rawData);
			this._loadedMonths.add(monthKey);
		} catch(err)
		{
			console.warn(`[Calendar] Could not load stream for ${monthKey}:`, err);
		}


	}
	/**
	 * Builds a detail preview DOM tree from JSON/Object payloads without string templates.
	 * Returns an HTMLElement directly to preserve formatting and bypass HTML string parsers.
	 */
	private _buildDetailPreviewHtml(detail: any): HTMLElement
	{
		const container = document.createElement('div');
		container.className = 'detail-preview-container';

		if(!detail) return container;

		let obj = detail;
		if(typeof detail === 'string')
		{
			try
			{
				obj = JSON.parse(detail);
			}
			catch
			{
				const textBlock = document.createElement('div');
				textBlock.className = 'detail-preview-text';
				textBlock.textContent = detail;
				container.appendChild(textBlock);
				return container;
			}
		}

		if(typeof obj !== 'object' || obj === null) return container;

		const table = document.createElement('div');
		table.className = 'detail-preview-table';

		let rowCount = 0;

		for(const [key, rawVal] of Object.entries(obj))
		{
			if(rawVal === undefined || rawVal === null || rawVal === '') continue;

			const row = document.createElement('div');
			row.className = 'detail-preview-row';

			const keyCell = document.createElement('span');
			keyCell.className = 'detail-key';
			keyCell.textContent = key
				.replace(/([A-Z])/g, ' $1')
				.replace(/^./, str => str.toUpperCase());

			const valCell = document.createElement('span');
			valCell.className = 'detail-value';

			if(Array.isArray(rawVal))
			{
				if(rawVal.length === 0) continue;

				const listContainer = document.createElement('ul');
				listContainer.className = 'detail-list';

				rawVal.slice(0, 4).forEach(v =>
				{
					const itemNode = document.createElement('li');
					itemNode.className = 'detail-list-item';
					itemNode.textContent = String(v);
					listContainer.appendChild(itemNode);
				});

				valCell.appendChild(listContainer);
			}
			else if(typeof rawVal === 'string' && (rawVal.startsWith('http://') || rawVal.startsWith('https://')))
			{
				let displayUrl = rawVal;
				try
				{
					const parsed = new URL(rawVal);
					displayUrl = parsed.hostname + (parsed.pathname.length > 1 ? parsed.pathname : '');
				}
				catch { }

				const linkNode = document.createElement('a');
				linkNode.className = 'detail-link';
				linkNode.href = rawVal;
				linkNode.target = '_blank';
				linkNode.rel = 'noopener noreferrer';
				linkNode.textContent = displayUrl;

				valCell.appendChild(linkNode);
			}
			else
			{
				valCell.textContent = String(rawVal);
			}

			row.appendChild(keyCell);
			row.appendChild(valCell);
			table.appendChild(row);
			rowCount++;
		}

		if(rowCount > 0)
		{
			container.appendChild(table);
		}

		return container;
	}

	private _escapeHtml(val: any): string
	{
		if(val === null || val === undefined) return '';
		const str = typeof val === 'string' ? val : String(val);
		return str
			.replace(/&/g, '&')
			.replace(/>/g, '>')
			.replace(/"/g, '"');
	}

	private _buildHeaderToolbar(): HTMLDivElement
	{
		const toolbar = document.createElement('div');
		toolbar.className = 'calendar-toolbar';

		// 1. Month / Year Select Navigation
		const navGroup = document.createElement('div');
		navGroup.className = 'toolbar-group';

		this._yearSelect = document.createElement('select');
		const currentYear = new Date().getFullYear();
		for(let y = currentYear + 2; y >= currentYear - 15; y--)
		{
			const opt = document.createElement('option');
			opt.value = y.toString();
			opt.textContent = y.toString();
			if(y === this._currentYear) opt.selected = true;
			this._yearSelect.appendChild(opt);
		}

		this._monthSelect = document.createElement('select');
		const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		months.forEach((m, idx) =>
		{
			const opt = document.createElement('option');
			opt.value = (idx + 1).toString();
			opt.textContent = m;
			if(idx + 1 === this._currentMonth) opt.selected = true;
			this._monthSelect.appendChild(opt);
		});

		const jumpBtn = document.createElement('button');
		jumpBtn.textContent = 'Jump';
		jumpBtn.addEventListener('click', () =>
		{
			this._currentYear = parseInt(this._yearSelect.value, 10);
			this._currentMonth = parseInt(this._monthSelect.value, 10);
			this._renderCalendarGrid();
		});

		navGroup.appendChild(this._yearSelect);
		navGroup.appendChild(this._monthSelect);
		navGroup.appendChild(jumpBtn);

		// 2. Category Checkbox Legend
		this._legendContainer = document.createElement('div');
		this._legendContainer.className = 'toolbar-legend';

		const categories: Array<string> = [
			'commits', 'bookmarks', 'history', 'locations', 'events'
		];

		categories.forEach(cat =>
		{
			const item = document.createElement('label');
			item.className = `legend-item legend-${cat}`;

			const chk = document.createElement('input');
			chk.type = 'checkbox';
			chk.checked = true;
			chk.addEventListener('change', () =>
			{
				if(chk.checked) this._activeCategories.add(cat);
				else this._activeCategories.delete(cat);
				this._renderCalendarGrid();
			});

			item.appendChild(chk);
			item.appendChild(document.createTextNode(` ${cat}`));
			this._legendContainer.appendChild(item);
		});

		// 3. Right-hand View Mode Switcher Buttons
		const viewSwitcherGroup = document.createElement('div');
		viewSwitcherGroup.className = 'view-switcher-group';

		const calendarBtn = document.createElement('button');
		calendarBtn.disabled = true; // Active view is disabled
		//calendarBtn.textContent = 'Calendar';
		calendarBtn.className = 'view-btn active bx bx-calendar-alt';

		const timelineBtn = document.createElement('a');
		timelineBtn.className = 'view-btn';
		timelineBtn.href = '#timeline';
		timelineBtn.className = 'bx bx-history';
		timelineBtn.title = 'Switch to Timeline View (2 weeks - 1 day)';
		timelineBtn.addEventListener('click', () =>
		{
			console.log('[View Switcher] Trigger switch to TimelineWidget');
		});

		const projectsBtn = document.createElement('a');
		projectsBtn.className = 'view-btn';
		projectsBtn.href = '#projects';
		projectsBtn.className = 'bx bx-briefcase-alt';
		projectsBtn.title = 'Switch to Projects Vertical List View';
		projectsBtn.addEventListener('click', () =>
		{
			console.log('[View Switcher] Trigger switch to ProjectsWidget');
		});

		viewSwitcherGroup.appendChild(calendarBtn);
		viewSwitcherGroup.appendChild(timelineBtn);
		viewSwitcherGroup.appendChild(projectsBtn);

		toolbar.appendChild(navGroup);
		toolbar.appendChild(this._legendContainer);
		toolbar.appendChild(viewSwitcherGroup);

		return toolbar;
	}


}
