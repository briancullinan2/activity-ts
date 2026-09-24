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

	// Project color cache mapping projectName -> hex color
	private _projectColorMap: Map<string, string> = new Map();

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

			if(this._indexData && this._indexData.projects)
			{
				this._initProjectColors(this._indexData.projects.map((p) => p.projectName));
			}

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

	/**
	 * Converts HSV color wheel parameters to an RGB Hex String
	 */
	private _hsvToHex(h: number, s: number, v: number): string
	{
		const f = (n: number, k = (n + h / 60) % 6) =>
			v - v * s * Math.max(Math.min(k, 4 - k, 1), 0);
		const r = Math.round(f(5) * 255);
		const g = Math.round(f(3) * 255);
		const b = Math.round(f(1) * 255);

		return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
	}

	/**
	 * Initializes golden-ratio spaced colors around the HSV color wheel for each project
	 */
	private _initProjectColors(projectNames: string[]): void
	{
		const sorted = Array.from(new Set(projectNames)).sort();
		const goldenRatio = 0.618033988749895;

		sorted.forEach((pName, idx) =>
		{
			const hue = ((idx * goldenRatio) % 1) * 360;
			const hex = this._hsvToHex(hue, 0.75, 0.90);
			this._projectColorMap.set(pName, hex);
		});
	}

	private _getProjectColor(projectName: string): string
	{
		if(!this._projectColorMap.has(projectName))
		{
			const hash = Array.from(projectName).reduce((acc, char) => char.charCodeAt(0) + acc, 0);
			const hue = (hash % 360);
			this._projectColorMap.set(projectName, this._hsvToHex(hue, 0.75, 0.90));
		}
		return this._projectColorMap.get(projectName) || '#1e90ff';
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

				// Strictly sort all parsed month commits descending by timestamp
				extractedCommits.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

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

			const dot = document.createElement('span');
			dot.className = 'ph-color-dot';
			dot.style.backgroundColor = this._getProjectColor(p.projectName);

			const label = document.createElement('span');
			label.textContent = p.projectName;

			btn.appendChild(dot);
			btn.appendChild(label);

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
		title.textContent = `Yearly Activity (${this._selectedYear}-${this._selectedMonth})`;
		this._heatmapContainer.appendChild(title);

		const svgContainer = document.createElement('div');
		svgContainer.className = 'ph-heatmap-svg-holder';
		const chartContainer = document.createElement('div');
		chartContainer.className = 'ph-chart-svg-holder';

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
				svgContainer.innerHTML = `<div class="ph-placeholder">Heatmap preview unavailable (${this._selectedYear})</div>`;
				//this._renderD3HeatmapFallback(svgContainer);
			}
		} catch
		{
			svgContainer.innerHTML = `<div class="ph-placeholder">Heatmap preview unavailable</div>`;
			//this._renderD3HeatmapFallback(svgContainer);
		}

		this._renderD3HeatmapFallback(chartContainer);
		this._heatmapContainer.appendChild(svgContainer);

		const title2 = document.createElement('div');
		title2.className = 'ph-section-title';
		title2.textContent = `Monthly Activity (${this._selectedYear}-${this._selectedMonth})`;
		this._heatmapContainer.appendChild(title2);
		this._heatmapContainer.appendChild(chartContainer);
	}

	/**
	 * D3 Fallback rendering full-width daily stacked activity bar charts per month
	 */
	private _renderD3HeatmapFallback(container: HTMLDivElement): void
	{
		const commits = this._getFilteredCommits();
		const [yearStr, monthStr] = this._selectedMonth.split('-');
		const year = parseInt(yearStr, 10);
		const month = parseInt(monthStr, 10);

		const daysInMonth = new Date(year, month, 0).getDate();

		// Aggregate daily metrics
		interface DayMetric
		{
			day: number;
			dateStr: string;
			linesAdded: number;
			linesDeleted: number;
			filesChangedCount: number;
			projects: Record<string, number>;
		}

		const dailyMap: Record<number, DayMetric> = {};
		for(let d = 1; d <= daysInMonth; d++)
		{
			const formattedDay = d < 10 ? `0${d}` : `${d}`;
			dailyMap[d] = {
				day: d,
				dateStr: `${this._selectedMonth}-${formattedDay}`,
				linesAdded: 0,
				linesDeleted: 0,
				filesChangedCount: 0,
				projects: {}
			};
		}

		commits.forEach((c) =>
		{
			const dayNum = parseInt(c.date.split('T')[0].split('-')[2], 10);
			if(dailyMap[dayNum])
			{
				dailyMap[dayNum].linesAdded += c.linesAdded;
				dailyMap[dayNum].linesDeleted += c.linesDeleted;
				dailyMap[dayNum].filesChangedCount += c.filesChanged.length;

				const proj = c.projectName || 'Unknown';
				dailyMap[dayNum].projects[proj] = (dailyMap[dayNum].projects[proj] || 0) + c.linesAdded + c.linesDeleted;
			}
		});

		const data = Object.values(dailyMap);

		const margin = { top: 30, right: 20, bottom: 40, left: 50 };
		const width = (container.clientWidth || 800) - margin.left - margin.right;
		const height = 180 - margin.top - margin.bottom;

		const svgElem = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svgElem.setAttribute('width', '100%');
		svgElem.setAttribute('height', '210');
		svgElem.style.display = 'block';
		container.appendChild(svgElem);

		const svg = d3.select(svgElem)
			.append('g')
			.attr('transform', `translate(${margin.left},${margin.top})`);

		const x = d3.scaleBand()
			.domain(data.map((d) => d.day.toString()))
			.range([0, width])
			.padding(0.2);

		const maxLines = d3.max(data, (d) => d.linesAdded + d.linesDeleted) || 100;

		const y = d3.scaleLinear()
			.domain([0, maxLines])
			.nice()
			.range([height, 0]);

		// Draw x Axis
		svg.append('g')
			.attr('transform', `translate(0,${height})`)
			.call(d3.axisBottom(x).tickSizeOuter(0))
			.selectAll('text')
			.style('fill', '#8b949e')
			.style('font-size', '10px');

		// Draw y Axis
		svg.append('g')
			.call(d3.axisLeft(y).ticks(4).tickFormat(d3.format('~s')))
			.selectAll('text')
			.style('fill', '#8b949e')
			.style('font-size', '10px');

		// Draw Bars
		data.forEach((d) =>
		{
			const barX = x(d.day.toString()) || 0;
			const totalLines = d.linesAdded + d.linesDeleted;

			if(totalLines > 0)
			{
				const barY = y(totalLines);
				const barHeight = height - barY;

				// Secondary project tint gradient/hue calculation
				const topProj = Object.keys(d.projects).sort((a, b) => d.projects[b] - d.projects[a])[0] || 'Unknown';
				const color = this._getProjectColor(topProj);

				const rect = svg.append('rect')
					.attr('x', barX)
					.attr('y', barY)
					.attr('width', x.bandwidth())
					.attr('height', barHeight)
					.attr('fill', color)
					.attr('rx', 2)
					.attr('opacity', this._selectedDateFilter === d.dateStr ? 1.0 : 0.75)
					.style('cursor', 'pointer');

				rect.on('click', () =>
				{
					this._selectedDateFilter = this._selectedDateFilter === d.dateStr ? null : d.dateStr;
					this._renderAll();
				});

				rect.append('title').text(`${d.dateStr}\n+${d.linesAdded} / -${d.linesDeleted} lines\n${d.filesChangedCount} files edited`);
			} else
			{
				// Empty placeholder day dot
				svg.append('circle')
					.attr('cx', barX + x.bandwidth() / 2)
					.attr('cy', height - 4)
					.attr('r', 1.5)
					.attr('fill', '#30363d');
			}
		});

		// Add Key / Legend
		const legend = svg.append('g').attr('transform', `translate(0, -18)`);

		legend.append('circle').attr('cx', 5).attr('cy', 0).attr('r', 4).attr('fill', '#2ed573');
		legend.append('text').attr('x', 14).attr('y', 3).text('Lines Added').style('fill', '#c9d1d9').style('font-size', '10px');

		legend.append('circle').attr('cx', 95).attr('cy', 0).attr('r', 4).attr('fill', '#ff4757');
		legend.append('text').attr('x', 104).attr('y', 3).text('Lines Deleted').style('fill', '#c9d1d9').style('font-size', '10px');
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

		const groupedByProject: Record<string, ProjectCommit[]> = {};
		commits.forEach((c) =>
		{
			const project = c.projectName || 'Unknown';
			if(!groupedByProject[project]) groupedByProject[project] = [];
			groupedByProject[project].push(c);
		});

		const sortedProjects = Object.keys(groupedByProject).sort();

		sortedProjects.forEach((project) =>
		{
			const projectGroup = groupedByProject[project];

			// Sort project commits chronologically newest-first
			projectGroup.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

			const card = document.createElement('div');
			card.className = 'ph-day-card';

			const header = document.createElement('div');
			header.className = 'ph-day-header';

			const projectColor = this._getProjectColor(project);

			header.innerHTML = `
        <div class="ph-day-title-holder">
          <span class="ph-color-dot" style="background-color: ${projectColor};"></span>
          <span class="ph-day-title" style="color: ${projectColor}">${project}</span>
        </div>
        <span class="ph-day-badge">${projectGroup.length} commit(s)</span>
      `;

			// Extract selected year from this._selectedMonth (e.g., "2026-09" -> "2026")
			const selectedYear = this._selectedMonth.split('-')[0];
			const svgUrl = `/components/projects/heat-maps/heatmap-${project}-${selectedYear}.svg`;

			// SVG Container - visible at the top of the card even when collapsed
			const heatmapContainer = document.createElement('div');
			heatmapContainer.className = 'ph-heatmap-container';
			heatmapContainer.innerHTML = `
        <img src="${svgUrl}"
             alt="${project} ${selectedYear} Heatmap"
             class="ph-heatmap-img"
             onerror="this.style.display='none';" />
      `;

			const content = document.createElement('div');
			content.className = 'ph-day-content hidden';

			projectGroup.forEach((commit) =>
			{
				const item = document.createElement('div');
				item.className = 'ph-commit-item';

				const repoUrl = this._resolveGithubUrl(commit.projectName);
				const commitDate = new Date(commit.date);

				item.innerHTML = `
          <div class="ph-commit-msg">
            <a href="${repoUrl}/commit/${commit.hash}" target="_blank" rel="noopener" class="ph-project-link">${commit.message}</a>
          </div>
          <div class="ph-commit-meta">+${commit.linesAdded} / -${commit.linesDeleted} • ${commitDate.toLocaleDateString()} ${commitDate.toLocaleTimeString()}</div>
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
			card.appendChild(heatmapContainer);
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
