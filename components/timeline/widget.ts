import { Widget } from '@lumino/widgets';
import { Message } from '@lumino/messaging';
import type { Timeline } from 'vis-timeline';
import type { DataSet } from 'vis-data';
import './vis-timeline-graph2d.min.js';
import type { LuminoLayoutWindow } from '../bundle/lumino.d';
import type { ITimelineItem } from './generate';

const widgetSelf = self as unknown as LuminoLayoutWindow & {
	vis: {
		Timeline?: typeof Timeline;
		DataSet?: typeof DataSet;
	};
};


export interface VisTimelineRawItem
{
	id: string;
	content: string;
	start: Date;                // Exact timestamp date for horizontal timeline
	end?: Date;
	className: string;
	title?: string;
	group?: number;
}

export class TimelineWidget extends Widget
{
	private _timelineContainer: HTMLDivElement;
	private _timeline: Timeline | null = null;
	private _itemsDataSet?: DataSet<VisTimelineRawItem> = widgetSelf.vis.DataSet ? new widgetSelf.vis.DataSet() : undefined;
	private _groupsDataSet?: DataSet<{ id: number; content: string; }> = widgetSelf.vis.DataSet ? new widgetSelf.vis.DataSet() : undefined;

	private _loadedMonths: Set<string> = new Set();
	private _autoUpdateInterval: number | null = null;
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
		this.addClass('jp-ActivityTimelineWidget');
		this.title.label = 'Activity Timeline';
		this.title.iconClass = 'fa fa-clock-o';
		this.title.closable = true;

		this.node.appendChild(this._buildHeaderToolbar());

		this._timelineContainer = document.createElement('div');
		this._timelineContainer.className = 'timeline-viewport-container';
		this.node.appendChild(this._timelineContainer);

		this.node.appendChild(this._buildFloatingZoomControls());
	}

	protected onAfterAttach(msg: Message): void
	{
		super.onAfterAttach(msg);
		if(!this._timeline)
		{
			this._initTimeline();
			this._startAutoRefresh();
		}
		this._syncViewportDimensions();
	}

	protected onResize(msg: Widget.ResizeMessage): void
	{
		super.onResize(msg);
		if(this._timeline)
		{
			this._timeline.redraw();
		}
		this._syncViewportDimensions();
	}


	private _syncViewportDimensions(): void
	{
		if(!this._timeline) return;
		const h = this._timelineContainer.clientHeight;
		if(h > 0)
		{
			this._timeline.setOptions({
				height: `${h}px`,
				maxHeight: `${h}px`
			});
			this._timeline.redraw();
		}
	}


	protected onBeforeDetach(msg: Message): void
	{
		super.onBeforeDetach(msg);
		if(this._autoUpdateInterval)
		{
			window.clearInterval(this._autoUpdateInterval);
			this._autoUpdateInterval = null;
		}
	}


	private _initTimeline(): void
	{
		const now = new Date();
		const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3);
		const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 4);

		const groups = [];
		for(let h = 0; h < 24; h++)
		{
			const hourStr = h.toString().padStart(2, '0');
			groups.push({
				id: h, // Group ID matches integer hour (0..23)
				content: `<div style="font-family: monospace; font-size: 11px; font-weight: bold; color: #aaa; text-align: right; padding-right: 6px;">${hourStr}:00</div>`
			});
		}
		this._groupsDataSet?.clear();
		this._groupsDataSet?.add(groups);

		const initialHeight = this._timelineContainer.clientHeight || 600;

		const options: any = {
			width: '100%',
			height: `${initialHeight}px`,
			maxHeight: `${initialHeight}px`,
			orientation: 'top',
			stack: true,
			showCurrentTime: true,
			groupOrder: (a: any, b: any) => a.id - b.id,
			margin: {
				item: { horizontal: 4, vertical: 2 },
				axis: 6
			},
			start: startDate,
			end: endDate,
			zoomMin: 1000 * 60 * 60 * 24,
			zoomMax: 1000 * 60 * 60 * 24 * 16,
			timeAxis: { scale: 'day', step: 1 }
		};

		if(!widgetSelf.vis.Timeline) return;

		this._timeline = new widgetSelf.vis.Timeline(
			this._timelineContainer,
			this._itemsDataSet ?? [],
			this._groupsDataSet ?? [],
			options
		);

		this._timeline.on('rangechanged', (properties: { start: Date; end: Date; }) =>
		{
			this._onViewportChanged(properties.start, properties.end);
		});

		setTimeout(() =>
		{
			const scrollEl = this._timelineContainer.querySelector('.vis-vertical-scroll') as HTMLElement;
			const leftEl = this._timelineContainer.querySelector('.vis-panel.vis-left') as HTMLElement;
			const centerEl = this._timelineContainer.querySelector('.vis-panel.vis-center') as HTMLElement;

			if(scrollEl)
			{
				scrollEl.addEventListener('scroll', () =>
				{
					const top = scrollEl.scrollTop;
					if(leftEl) leftEl.scrollTop = top;
					if(centerEl) centerEl.scrollTop = top;
				}, { passive: true });
			}
		}, 200);

		this._updateHeaderDateSelectors(now);
		this._onViewportChanged(startDate, endDate);
	}


	private _onViewportChanged(start: Date, end: Date): void
	{
		// 1. Update month and year select UI to match center of visible window
		const midTime = new Date((start.getTime() + end.getTime()) / 2);
		this._updateHeaderDateSelectors(midTime);

		// 2. Fetch data streams for all months currently visible in range
		const startYear = start.getFullYear();
		const startMonth = start.getMonth() + 1;
		const endYear = end.getFullYear();
		const endMonth = end.getMonth() + 1;

		let curY = startYear;
		let curM = startMonth;

		while(curY < endYear || (curY === endYear && curM <= endMonth))
		{
			this._fetchMonthData(curY, curM);
			curM++;
			if(curM > 12)
			{
				curM = 1;
				curY++;
			}
		}
	}

	private _updateHeaderDateSelectors(targetDate: Date): void
	{
		const yStr = targetDate.getFullYear().toString();
		const mStr = (targetDate.getMonth() + 1).toString().padStart(2, '0');

		if(this._yearSelect.value !== yStr)
		{
			this._yearSelect.value = yStr;
		}
		if(this._monthSelect.value !== mStr)
		{
			this._monthSelect.value = mStr;
		}
	}


	private async _fetchMonthData(year: number, month: number): Promise<void>
	{
		const monthKey = `${year}-${month.toString().padStart(2, '0')}`;
		if(this._loadedMonths.has(monthKey)) return;
		this._loadedMonths.add(monthKey);

		try
		{
			const response = await fetch(`/components/timeline/data/timeline-${monthKey}.json`, {
				signal: AbortSignal.timeout(15000)
			});
			if(!response.ok) return;

			const rawData: ITimelineItem[] = await response.json();
			this._processAndAddItems(rawData);

			// Force Vis to recalculate vertical scrollbar height after items populate
			if(this._timeline)
			{
				this._syncViewportDimensions();
			}
		} catch(err)
		{
			console.warn(`[Timeline] Could not load stream for ${monthKey}:`, err);
		}
	}



	private _processAndAddItems(items: ITimelineItem[]): void
	{
		const prepared: VisTimelineRawItem[] = [];

		// 1. Group items by Category + Date + Hour + 15-Min Bucket
		const bucketMap = new Map<string, ITimelineItem[]>();

		items.forEach(item =>
		{
			if(!this._activeCategories.has(item.category)) return;

			const d = new Date(item.timestamp);
			const year = d.getFullYear();
			const month = String(d.getMonth() + 1).padStart(2, '0');
			const day = String(d.getDate()).padStart(2, '0');
			const hour = d.getHours();
			const bucketMin = Math.floor(d.getMinutes() / 15) * 15; // 0, 15, 30, 45

			const key = `${item.category}_${year}-${month}-${day}_H${hour}_M${bucketMin}`;
			if(!bucketMap.has(key)) bucketMap.set(key, []);
			bucketMap.get(key)!.push(item);
		});

		// 2. Build items or summary nodes
		bucketMap.forEach((bucketItems, key) =>
		{
			const first = bucketItems[0];
			const d = new Date(first.timestamp);
			const hour = d.getHours();

			const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
			const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);

			let contentHtml = '';
			let topClassName = `timeline-node node-${first.category}`;

			if(bucketItems.length === 1)
			{
				// Standard single item card
				const detailHtml = this._buildDetailPreviewHtml(first.detail);
				contentHtml = `
                <div style="background: #252526; border: 1px solid #3c3c3c; border-left: 3px solid #0e639c; border-radius: 3px; padding: 3px 6px; width: 100%; box-sizing: border-box; font-size: 11px; color: #cccccc; box-shadow: 0 1px 4px rgba(0,0,0,0.4);">
                  <div style="display: flex; align-items: center; gap: 4px; font-size: 10px; white-space: nowrap;">
                    <span style="width: 6px; height: 6px; border-radius: 50%; display: inline-block; flex-shrink: 0; background-color: #0e639c;"></span>
                    <span style="font-family: monospace; color: #888; font-size: 10px;">${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                    <span style="text-transform: uppercase; font-size: 8px; color: #666; margin-left: auto;">${first.category}</span>
                  </div>
                  <div style="font-weight: 600; color: #ffffff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2; margin-top: 1px;">${this._escapeHtml(first.title)}</div>
                  ${detailHtml ? detailHtml : ''}
                </div>
            `;
			} else
			{
				// Multi-item Summary Stack Node
				topClassName += ' timeline-summary-node';
				const bucketMin = Math.floor(d.getMinutes() / 15) * 15;
				const timeRangeStr = `${String(hour).padStart(2, '0')}:${String(bucketMin).padStart(2, '0')}`;

				const summaryList = bucketItems.map(it =>
					it.detail && it.detail.url
						? `<li style="margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"><a target="_blank" title="${this._escapeHtml(it.detail.url)}" href="${this._escapeHtml(it.detail.url)}">${this._escapeHtml(it.title)}</a></li>`
						: `<li style="margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${this._escapeHtml(it.title)}</li>`
				).join('');

				contentHtml = `
                <div style="background: #1e2430; border: 1px dashed #4ea5ff; border-left: 4px solid #4ea5ff; border-radius: 3px; padding: 3px 6px; width: 100%; box-sizing: border-box; font-size: 11px; color: #ffffff; box-shadow: 0 2px 6px rgba(0,0,0,0.5);">
                  <div style="display: flex; align-items: center; gap: 6px;">
				  	<span></span>
                    <span style="font-family: monospace; color: #aaa; font-size: 10px;">${timeRangeStr}</span>
                    <span style="background: #0e639c; color: #fff; font-weight: bold; font-size: 9px; padding: 1px 5px; border-radius: 8px;">+${bucketItems.length} ${first.category}</span>
                  </div>
                  <ul style="margin: 4px 0 0 0; padding-left: 12px; font-size: 10px; color: #cccccc; max-height: 60px; overflow: hidden;">
                    ${summaryList}
                  </ul>
                </div>
            `;
			}

			prepared.push({
				id: `bucket_${key}`,
				group: hour,              // 0..23 Hour swimlane
				content: contentHtml,
				start: dayStart,
				end: dayEnd,
				className: topClassName   // Class applied to top-level .vis-item
			});
		});

		this._itemsDataSet?.add(prepared);

		// Auto-shrink container to fit visible items
		if(this._timeline)
		{
			this._timeline.redraw();
		}
	}


	private _buildDetailPreviewHtml(detail: any): string
	{
		if(!detail) return '';

		let obj = detail;
		if(typeof detail === 'string')
		{
			try
			{
				obj = JSON.parse(detail);
			} catch
			{
				return `<div style="font-size: 10px; color: #aaaaaa; word-break: break-all;">${this._escapeHtml(detail)}</div>`;
			}
		}

		if(typeof obj !== 'object' || obj === null) return '';

		const rows: string[] = [];

		for(const [key, rawVal] of Object.entries(obj))
		{
			if(rawVal === undefined || rawVal === null || rawVal === '') continue;

			const formattedKey = this._escapeHtml(
				key.replace(/([A-Z])/g, ' $1')
					.replace(/^./, str => str.toUpperCase())
			);

			let formattedVal = '';

			if(Array.isArray(rawVal))
			{
				if(rawVal.length === 0) continue;
				const items = rawVal.slice(0, 5).map(v =>
					`<span style="background: #3c3c3c; color: #cccccc; font-size: 9px; padding: 1px 4px; border-radius: 2px; white-space: nowrap;">${this._escapeHtml(String(v))}</span>`
				).join('');
				const more = rawVal.length > 5 ? `<span style="font-size: 9px; color: #888888; align-self: center;">+${rawVal.length - 5}</span>` : '';
				formattedVal = `<div style="display: flex; flex-wrap: wrap; gap: 2px;">${items}${more}</div>`;
			}
			else if(typeof rawVal === 'string' && (rawVal.startsWith('http://') || rawVal.startsWith('https://')))
			{
				let displayUrl = rawVal;
				try
				{
					const parsed = new URL(rawVal);
					displayUrl = parsed.hostname + (parsed.pathname.length > 1 ? parsed.pathname : '');
				} catch { }

				formattedVal = `<a target="_blank" href="${this._escapeHtml(rawVal)}" target="_blank" rel="noopener" title="${this._escapeHtml(rawVal)}" style="color: #4ea5ff; text-decoration: none;">${this._escapeHtml(displayUrl)}</a>`;
			}
			else if(typeof rawVal === 'object')
			{
				formattedVal = `<code style="font-family: monospace; font-size: 9px; background: #1e1e1e; padding: 1px 3px; border-radius: 2px; color: #ce9178;">${this._escapeHtml(JSON.stringify(rawVal))}</code>`;
			}
			else
			{
				formattedVal = this._escapeHtml(String(rawVal));
			}

			rows.push(`
            <dt style="font-weight: 600; color: #888888; text-align: right; white-space: nowrap; user-select: none; margin: 0;">${formattedKey}</dt>
            <dd style="color: #dddddd; word-break: break-all; overflow-wrap: anywhere; margin: 0;">${formattedVal}</dd>
        `);
		}

		if(rows.length === 0) return '';

		// Semantic Definition List <dl> with grid layout inline
		return `<dl style="display: grid; grid-template-columns: minmax(65px, max-content) 1fr; gap: 3px 8px; font-size: 10px; line-height: 1.3; padding-top: 4px; margin: 4px 0 0 0; border-top: 1px solid #3c3c3c; width: 100%; box-sizing: border-box;">${rows.join('')}</dl>`;
	}

	private _escapeHtml(val: any): string
	{
		if(val === null || val === undefined) return '';
		const str = typeof val === 'string' ? val : String(val);
		return str
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}


	private _startAutoRefresh(): void
	{
		this._autoUpdateInterval = window.setInterval(() =>
		{
			if(!this._timeline) return;
			const windowRange = this._timeline.getWindow();
			this._onViewportChanged(windowRange.start, windowRange.end);
		}, 5000);
	}

	// --- UI CONTROLS & HEADER BUILDERS ---

	private _buildHeaderToolbar(): HTMLDivElement
	{
		const toolbar = document.createElement('div');
		toolbar.className = 'timeline-toolbar';

		// Jump Navigation
		const navGroup = document.createElement('div');
		navGroup.className = 'toolbar-group';

		this._yearSelect = document.createElement('select');
		const currentYear = new Date().getFullYear();
		for(let y = currentYear + 2; y >= currentYear - 15; y--)
		{
			const opt = document.createElement('option');
			opt.value = y.toString();
			opt.textContent = y.toString();
			this._yearSelect.appendChild(opt);
		}

		this._monthSelect = document.createElement('select');
		const months = [
			'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
			'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
		];
		months.forEach((m, idx) =>
		{
			const opt = document.createElement('option');
			opt.value = (idx + 1).toString().padStart(2, '0');
			opt.textContent = m;
			this._monthSelect.appendChild(opt);
		});

		const jumpBtn = document.createElement('button');
		jumpBtn.textContent = 'Jump';
		jumpBtn.addEventListener('click', () =>
		{
			const y = parseInt(this._yearSelect.value, 10);
			const m = parseInt(this._monthSelect.value, 10) - 1;

			if(this._timeline)
			{
				const targetStart = new Date(y, m, 1);
				const targetEnd = new Date(y, m, 7);
				this._timeline.setWindow(targetStart, targetEnd);
			}
		});

		navGroup.appendChild(this._yearSelect);
		navGroup.appendChild(this._monthSelect);
		navGroup.appendChild(jumpBtn);

		// Filter Legend
		this._legendContainer = document.createElement('div');
		this._legendContainer.className = 'toolbar-legend';

		const categories: Array<ITimelineItem['category']> = [
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
				if(chk.checked)
				{
					this._activeCategories.add(cat);
				} else
				{
					this._activeCategories.delete(cat);
				}
				this._applyCategoryFilter();
			});

			item.appendChild(chk);
			item.appendChild(document.createTextNode(` ${cat}`));
			this._legendContainer.appendChild(item);
		});

		toolbar.appendChild(navGroup);
		toolbar.appendChild(this._legendContainer);

		return toolbar;
	}

	private _applyCategoryFilter(): void
	{
		this._itemsDataSet?.clear();
		const loaded = Array.from(this._loadedMonths);
		this._loadedMonths.clear();
		loaded.forEach(mKey =>
		{
			const [y, m] = mKey.split('-').map(Number);
			this._fetchMonthData(y, m);
		});
	}

	private _buildFloatingZoomControls(): HTMLDivElement
	{
		const container = document.createElement('div');
		container.className = 'timeline-floating-controls';

		const zoomIn = document.createElement('button');
		zoomIn.innerHTML = '&#43;';
		zoomIn.title = 'Zoom In';
		zoomIn.addEventListener('click', () =>
		{
			if(this._timeline) this._timeline.zoomIn(0.4);
		});

		const zoomOut = document.createElement('button');
		zoomOut.innerHTML = '&#8722;';
		zoomOut.title = 'Zoom Out';
		zoomOut.addEventListener('click', () =>
		{
			if(this._timeline) this._timeline.zoomOut(0.4);
		});

		container.appendChild(zoomIn);
		container.appendChild(zoomOut);
		return container;
	}

}
