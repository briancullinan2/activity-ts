import { Widget } from '@lumino/widgets';
import { Message } from '@lumino/messaging';
import * as d3 from 'd3';
import type { CompactMasterManifest } from './generate';

export interface ProjectCommit
{
	hash: string;
	author: string;
	date: string;
	message: string;
	linesAdded: number;
	linesDeleted: number;
	filesChanged: string[];
	projectName: string;
}

export class ProjectsWidget extends Widget
{
	private _indexData: CompactMasterManifest | null = null;
	private _selectedYear: number = 2026;
	private _selectedMonth: string = '2026-07';
	private _selectedProject: string = 'ALL';
	private _selectedDateFilter: string | null = null;
	private _monthlyDetails: Record<string, ProjectCommit[]> = {};

	private _headerElem!: HTMLDivElement;
	private _heatmapContainer!: HTMLDivElement;
	private _quadChartContainer!: HTMLDivElement;
	private _filterBarElem!: HTMLDivElement;
	private _accordionContainer!: HTMLDivElement;

	constructor()
	{
		super();
		this.addClass('ph-project-history-widget');
		this.title.label = 'Project History';
		this.title.iconClass = 'bx bx-briefcase-alt';
		this.title.closable = true;

		this._buildSkeleton();
	}

	protected onAfterAttach(msg: Message): void
	{
		super.onAfterAttach(msg);
		this._bootstrap();
	}

	private _buildSkeleton(): void
	{
		this.node.innerHTML = '';

		const controlsBar = document.createElement('div');
		controlsBar.className = 'ph-controls-bar';

		const prevBtn = document.createElement('button');
		prevBtn.className = 'ph-nav-btn';
		prevBtn.innerHTML = '&#9664; Prev';
		prevBtn.onclick = () => this._navigateMonth(-1);

		const yearSelect = document.createElement('select');
		yearSelect.className = 'ph-select ph-year-select';
		yearSelect.onchange = (e) =>
		{
			const year = parseInt((e.target as HTMLSelectElement).value, 10);
			this._onYearChanged(year);
		};

		const monthSelect = document.createElement('select');
		monthSelect.className = 'ph-select ph-month-select';
		monthSelect.onchange = (e) =>
		{
			const ym = (e.target as HTMLSelectElement).value;
			this._onMonthChanged(ym);
		};

		const nextBtn = document.createElement('button');
		nextBtn.className = 'ph-nav-btn';
		nextBtn.innerHTML = 'Next &#9654;';
		nextBtn.onclick = () => this._navigateMonth(1);

		controlsBar.appendChild(prevBtn);
		controlsBar.appendChild(yearSelect);
		controlsBar.appendChild(monthSelect);
		controlsBar.appendChild(nextBtn);

		this._headerElem = controlsBar;
		this.node.appendChild(this._headerElem);

		this._heatmapContainer = document.createElement('div');
		this._heatmapContainer.className = 'ph-heatmap-section';
		this.node.appendChild(this._heatmapContainer);

		this._quadChartContainer = document.createElement('div');
		this._quadChartContainer.className = 'ph-quad-chart-section';
		this.node.appendChild(this._quadChartContainer);

		this._filterBarElem = document.createElement('div');
		this._filterBarElem.className = 'ph-project-filter-bar';
		this.node.appendChild(this._filterBarElem);

		this._accordionContainer = document.createElement('div');
		this._accordionContainer.className = 'ph-accordion-container';
		this.node.appendChild(this._accordionContainer);
	}

	private async _bootstrap(): Promise<void>
	{
		try
		{
			const res = await fetch('/components/projects/projects-data.json');
			this._indexData = await res.json();

			if(this._indexData && this._indexData.availableMonths && this._indexData.availableMonths.length > 0)
			{
				this._selectedMonth = this._indexData.availableMonths[0];
				this._selectedYear = parseInt(this._selectedMonth.split('-')[0], 10);
			}

			this._updateSelectDropdowns();
			this._renderFilterTabs();
			await this._loadCurrentMonthData();
			this._renderAll();
		} catch(err)
		{
			this._accordionContainer.innerHTML = `<div class="ph-error">Failed loading index data: ${err}</div>`;
		}
	}

	private _updateSelectDropdowns(): void
	{
		if(!this._indexData) return;

		const yearSelect = this._headerElem.querySelector('.ph-year-select') as HTMLSelectElement;
		const monthSelect = this._headerElem.querySelector('.ph-month-select') as HTMLSelectElement;

		yearSelect.innerHTML = '';
		this._indexData.availableYears.forEach((y) =>
		{
			const opt = document.createElement('option');
			opt.value = y.toString();
			opt.textContent = y.toString();
			if(y === this._selectedYear) opt.selected = true;
			yearSelect.appendChild(opt);
		});

		monthSelect.innerHTML = '';
		const filteredMonths = this._indexData.availableMonths.filter((m) =>
			m.startsWith(`${this._selectedYear}-`)
		);

		filteredMonths.forEach((m) =>
		{
			const opt = document.createElement('option');
			opt.value = m;
			const dateObj = new Date(`${m}-01T00:00:00`);
			opt.textContent = dateObj.toLocaleString('default', { month: 'long' });
			if(m === this._selectedMonth) opt.selected = true;
			monthSelect.appendChild(opt);
		});
	}

	private async _onYearChanged(year: number): Promise<void>
	{
		this._selectedYear = year;
		const match = this._indexData?.availableMonths.find((m) => m.startsWith(`${year}-`));
		if(match)
		{
			this._selectedMonth = match;
		}
		this._selectedDateFilter = null;
		this._updateSelectDropdowns();
		await this._loadCurrentMonthData();
		this._renderAll();
	}

	private async _onMonthChanged(ym: string): Promise<void>
	{
		this._selectedMonth = ym;
		this._selectedYear = parseInt(ym.split('-')[0], 10);
		this._selectedDateFilter = null;
		this._updateSelectDropdowns();
		await this._loadCurrentMonthData();
		this._renderAll();
	}

	private async _navigateMonth(delta: number): Promise<void>
	{
		if(!this._indexData) return;
		const idx = this._indexData.availableMonths.indexOf(this._selectedMonth);
		if(idx === -1) return;

		const targetIdx = idx - delta;
		if(targetIdx >= 0 && targetIdx < this._indexData.availableMonths.length)
		{
			const targetYM = this._indexData.availableMonths[targetIdx];
			await this._onMonthChanged(targetYM);
		}
	}

	private async _loadCurrentMonthData(): Promise<void>
	{
		if(this._monthlyDetails[this._selectedMonth]) return;

		try
		{
			const fileToFetch = `project-data-${this._selectedMonth}.json`;
			const res = await fetch('/components/projects/data/' + fileToFetch);
			if(res.ok)
			{
				const raw = await res.json();
				const extractedCommits: ProjectCommit[] = [];

				if(raw.projects && typeof raw.projects === 'object')
				{
					Object.entries(raw.projects).forEach(([projKey, projVal]: [string, any]) =>
					{
						const projName = projVal.projectName || projKey;
						if(projVal.dailyHeat && typeof projVal.dailyHeat === 'object')
						{
							Object.values(projVal.dailyHeat).forEach((dayEntry: any) =>
							{
								if(Array.isArray(dayEntry.commits))
								{
									dayEntry.commits.forEach((c: any) =>
									{
										extractedCommits.push({
											hash: c.hash || '',
											author: c.author || '',
											date: c.date || '',
											message: c.message || '',
											linesAdded: c.linesAdded || 0,
											linesDeleted: c.linesDeleted || 0,
											filesChanged: Array.isArray(c.filesChanged) ? c.filesChanged : [],
											projectName: projName
										});
									});
								}
							});
						}
					});
				}

				this._monthlyDetails[this._selectedMonth] = extractedCommits;
			}
		} catch
		{
			this._monthlyDetails[this._selectedMonth] = [];
		}
	}

	private _renderAll(): void
	{
		this._renderHeatmap();
		this._renderQuadChart();
		this._renderAccordions();
	}

	private _renderFilterTabs(): void
	{
		if(!this._indexData) return;
		this._filterBarElem.innerHTML = '';

		const allTab = document.createElement('button');
		allTab.className = `ph-tab-btn ${this._selectedProject === 'ALL' ? 'active' : ''}`;
		allTab.textContent = 'All Projects';
		allTab.onclick = () =>
		{
			this._selectedProject = 'ALL';
			this._renderFilterTabs();
			this._renderAll();
		};
		this._filterBarElem.appendChild(allTab);

		this._indexData.projects.forEach((p) =>
		{
			const btn = document.createElement('button');
			btn.className = `ph-tab-btn ${this._selectedProject === p.projectName ? 'active' : ''}`;
			btn.textContent = p.projectName;
			btn.onclick = () =>
			{
				this._selectedProject = p.projectName;
				this._renderFilterTabs();
				this._renderAll();
			};
			this._filterBarElem.appendChild(btn);
		});
	}

	private async _renderHeatmap(): Promise<void>
	{
		this._heatmapContainer.innerHTML = '';

		const title = document.createElement('div');
		title.className = 'ph-section-title';
		title.textContent = `${this._selectedYear} Activity Matrix`;
		this._heatmapContainer.appendChild(title);

		const svgContainer = document.createElement('div');
		svgContainer.className = 'ph-heatmap-svg-holder';

		try
		{
			const svgRes = await fetch(`/components/projects/data/heatmap-${this._selectedYear}.svg`);
			if(svgRes.ok)
			{
				const svgText = await svgRes.text();
				svgContainer.innerHTML = svgText;
				this._makeSvgInteractive(svgContainer);
			} else
			{
				svgContainer.innerHTML = `<div class="ph-placeholder">No heatmap SVG found for ${this._selectedYear}</div>`;
			}
		} catch
		{
			svgContainer.innerHTML = `<div class="ph-placeholder">Heatmap preview unavailable</div>`;
		}

		this._heatmapContainer.appendChild(svgContainer);
	}

	private _makeSvgInteractive(holder: HTMLDivElement): void
	{
		const rects = holder.querySelectorAll('rect[data-date], rect.day');
		rects.forEach((r) =>
		{
			const rect = r as SVGRectElement;
			rect.style.cursor = 'pointer';
			rect.addEventListener('click', () =>
			{
				const dateAttr = rect.getAttribute('data-date') || rect.getAttribute('date');
				if(dateAttr)
				{
					this._selectedDateFilter = this._selectedDateFilter === dateAttr ? null : dateAttr;
					this._renderAccordions();
				}
			});
		});
	}

	private _getFilteredCommits(): ProjectCommit[]
	{
		const commits = this._monthlyDetails[this._selectedMonth] || [];

		return commits.filter((c) =>
		{
			const matchProject =
				this._selectedProject === 'ALL' || c.projectName === this._selectedProject;

			const matchDate =
				!this._selectedDateFilter || c.date.startsWith(this._selectedDateFilter);

			return matchProject && matchDate;
		});
	}

	private _renderQuadChart(): void
	{
		this._quadChartContainer.innerHTML = '';

		const title = document.createElement('div');
		title.className = 'ph-section-title';
		title.textContent = `Month Metric Quad (${this._selectedMonth})`;
		this._quadChartContainer.appendChild(title);

		const svgElem = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svgElem.setAttribute('width', '100%');
		svgElem.setAttribute('height', '240');
		svgElem.className.baseVal = 'ph-quad-svg';
		this._quadChartContainer.appendChild(svgElem);

		const commits = this._getFilteredCommits();

		const metrics = {
			totalCommits: commits.length,
			linesAdded: commits.reduce((acc, c) => acc + c.linesAdded, 0),
			linesDeleted: commits.reduce((acc, c) => acc + c.linesDeleted, 0),
			activeDays: new Set(commits.map((c) => c.date.split('T')[0])).size
		};

		const svg = d3.select(svgElem);
		const width = this._quadChartContainer.clientWidth || 600;
		const height = 240;

		svg.append('line').attr('x1', width / 2).attr('y1', 10).attr('x2', width / 2).attr('y2', height - 10).attr('stroke', '#30363d').attr('stroke-width', 2);
		svg.append('line').attr('x1', 10).attr('y1', height / 2).attr('x2', width - 10).attr('y2', height / 2).attr('stroke', '#30363d').attr('stroke-width', 2);

		const quads = [
			{ label: 'Commits', val: metrics.totalCommits, color: '#2ed573', x: width * 0.25, y: height * 0.25 },
			{ label: 'Lines Added', val: metrics.linesAdded, color: '#1e90ff', x: width * 0.75, y: height * 0.25 },
			{ label: 'Lines Removed', val: metrics.linesDeleted, color: '#ff4757', x: width * 0.25, y: height * 0.75 },
			{ label: 'Active Days', val: metrics.activeDays, color: '#ffa502', x: width * 0.75, y: height * 0.75 }
		];

		quads.forEach((q) =>
		{
			const g = svg.append('g').attr('transform', `translate(${q.x}, ${q.y})`);
			g.append('circle').attr('r', 32).attr('fill', q.color).attr('opacity', 0.15);
			g.append('text').attr('text-anchor', 'middle').attr('dy', '-0.2em').attr('fill', '#c9d1d9').style('font-size', '12px').text(q.label);
			g.append('text').attr('text-anchor', 'middle').attr('dy', '1.1em').attr('fill', '#ffffff').style('font-size', '18px').style('font-weight', 'bold').text(q.val.toLocaleString());
		});
	}

	private _renderAccordions(): void
	{
		this._accordionContainer.innerHTML = '';

		const commits = this._getFilteredCommits();

		if(commits.length === 0)
		{
			this._accordionContainer.innerHTML = `<div class="ph-placeholder">No commits documented for ${this._selectedMonth}</div>`;
			return;
		}

		const groupedByDay: Record<string, ProjectCommit[]> = {};
		commits.forEach((c) =>
		{
			const day = c.date.split('T')[0] || 'Unknown';
			if(!groupedByDay[day]) groupedByDay[day] = [];
			groupedByDay[day].push(c);
		});

		const sortedDays = Object.keys(groupedByDay).sort().reverse();

		sortedDays.forEach((day) =>
		{
			const dayGroup = groupedByDay[day];
			const card = document.createElement('div');
			card.className = 'ph-day-card';

			const header = document.createElement('div');
			header.className = 'ph-day-header';
			header.innerHTML = `
        <span class="ph-day-title">${day}</span>
        <span class="ph-day-badge">${dayGroup.length} commit(s)</span>
      `;

			const content = document.createElement('div');
			content.className = 'ph-day-content hidden';

			dayGroup.forEach((commit) =>
			{
				const item = document.createElement('div');
				item.className = 'ph-commit-item';

				const repoUrl = this._resolveGithubUrl(commit.projectName);

				item.innerHTML = `
          <div class="ph-commit-msg">
            <span class="ph-project-tag">[${commit.projectName}]</span>
            <a href="${repoUrl}/commit/${commit.hash}" target="_blank" rel="noopener" class="ph-project-link">${commit.message}</a>
          </div>
          <div class="ph-commit-meta">+${commit.linesAdded} / -${commit.linesDeleted} • ${new Date(commit.date).toLocaleTimeString()}</div>
          <div class="ph-file-list">
            ${commit.filesChanged
						.map((f) =>
						{
							const fileGithubUrl = `${repoUrl}/blob/main/${f}`;
							return `<a href="${fileGithubUrl}" target="_blank" rel="noopener" class="ph-file-link">${f}</a>`;
						})
						.join('<br/>')}
          </div>
        `;
				content.appendChild(item);
			});

			header.onclick = () =>
			{
				content.classList.toggle('hidden');
			};

			card.appendChild(header);
			card.appendChild(content);
			this._accordionContainer.appendChild(card);
		});
	}

	private _resolveGithubUrl(projectName: string): string
	{
		const matched = this._indexData?.projects.find((p) => p.projectName === projectName);
		if(matched && matched.remoteUrl)
		{
			let url = matched.remoteUrl.replace('git@github.com:', 'https://github.com/');
			if(url.endsWith('.git')) url = url.slice(0, -4);
			return url;
		}
		return `https://github.com/briancullinan2/${projectName}`;
	}
}
