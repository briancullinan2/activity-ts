import { Widget } from '@lumino/widgets';
import { Message } from '@lumino/messaging';
import { SkillsWidget } from './widget-skills';
import type { LuminoLayoutWindow } from '../bundle/lumino.d';
import type { GlobalToolbarsWindow } from '../bundle/menu.d';

import 'd3';
declare const d3: typeof import('d3');

const widgetSelf = self as unknown as LuminoLayoutWindow & GlobalToolbarsWindow & {
	ResumeWidget?: typeof ResumeWidget;
	SkillsWidget?: typeof SkillsWidget;
};

export interface ICommitEvent
{
	start: Date;
	end: Date;
}

export interface ISkillMetric
{
	name: string;
	years: number;
	category: 'skill' | 'tool' | 'core_language';
	proficiency?: string;
}

export interface IEmploymentEntry
{
	period: string;
	role: string;
	company: string;
	location: string;
	narrative: string;
	related_skills: string[];
	highlights: string[];
}

export interface IEducationEntry
{
	institution: string;
	degree: string;
	graduation_year: number;
	gpa: string;
	relevant_coursework: string[];
	related_skills: string[];
	details: string;

}

export interface IExtracurricularEntry
{
	title: string;
	duration: string;
	details: string;
	related_skills: string[];
}

export interface IFullResumeData
{
	applicant_profile: {
		full_name: string;
		headline: string;
		contact: {
			phone: string;
			email: string;
			location: string;
			website: string;
			github: string;
		};
		federal_metadata: {
			citizenship: string;
			special_hiring_authority: string;
			clearance: string;
			objective: string;
		};
		executive_summary: string;
	};
	skills_and_technologies_matrix: {
		summary: string;
		skills: ISkillMetric[];
		core_languages: ISkillMetric[];
		tools_and_infrastructure: ISkillMetric[];
		advanced_frameworks_and_specializations: string[];
	};
	employment_history: IEmploymentEntry[];
	education: IEducationEntry[];
	extracurricular_and_sabbaticals: IExtracurricularEntry[];
}

/**
 * Lumino Interactive Resume Anthology, Glassmorphism Flash Card Engine & Printable Document Visualizer
 */
export class ResumeWidget extends Widget
{
	public static instance: ResumeWidget | null = null;
	private static _resumeDataPromise: Promise<IFullResumeData | undefined> | null = null;
	private static _cachedResumeData?: IFullResumeData;

	public _activeFilter: string | null = null;
	private _gitEvents: ICommitEvent[] = [];
	private _activeSection: 'all' | 'profile' | 'skills' | 'experience' | 'education' | 'sabbaticals' = 'all';

	// Master JSON Dataset
	private _resumeData?: IFullResumeData;

	// DOM References
	private _skillsBarChartEl!: HTMLDivElement;
	private _heatmapSvgEl!: SVGSVGElement;
	private _cardsContainerEl!: HTMLDivElement;
	public _filterBadgeEl!: HTMLDivElement;
	private _navTabsContainerEl!: HTMLDivElement;

	constructor()
	{
		if(ResumeWidget.instance)
		{
			return ResumeWidget.instance;
		}
		super();
		this.addClass('lm-ResumeWidget');
		this.id = 'resume-anthology-widget';

		this.node.style.overflow = 'hidden';
		this.node.style.display = 'flex';
		this.node.style.flexDirection = 'column';
		this.node.style.height = '100%';
		this.node.style.width = '100%';
		this.node.style.backgroundColor = '#121214';
		this.node.style.color = '#e1e1e6';
		this.node.style.fontFamily = 'Consolas, "Courier New", monospace';

		this.title.label = 'Resume';
		this.title.iconClass = 'bx bx-education';
		this.title.closable = true;

		ResumeWidget.instance = this;
	}

	/**
	 * Deduplicated static data accessor. Shared between ResumeWidget and ExhaustiveSkillsWidget.
	 */
	public static async getSharedResumeData(): Promise<IFullResumeData | undefined>
	{
		if(ResumeWidget._cachedResumeData)
		{
			return ResumeWidget._cachedResumeData;
		}

		if(!ResumeWidget._resumeDataPromise)
		{
			ResumeWidget._resumeDataPromise = (async () =>
			{
				try
				{
					const controller = new AbortController();
					const timeoutId = setTimeout(() => controller.abort(), 15000);

					const response = await fetch('/components/resume/resume-data.json', { signal: controller.signal });
					clearTimeout(timeoutId);

					if(!response.ok)
					{
						throw new Error(`Failed to load resume dataset: ${response.statusText}`);
					}

					ResumeWidget._cachedResumeData = await response.json();
					return ResumeWidget._cachedResumeData;
				} catch(error)
				{
					console.warn('ResumeWidget: Server fetch failed or timed out.', error);
					return undefined;
				} finally
				{
					ResumeWidget._resumeDataPromise = null;
				}
			})();
		}

		return ResumeWidget._resumeDataPromise;
	}


	public static getInstance(): ResumeWidget
	{
		if(!ResumeWidget.instance || ResumeWidget.instance.isDisposed)
		{
			ResumeWidget.instance = new ResumeWidget();
		}
		return ResumeWidget.instance;
	}

	protected onAfterAttach(msg: Message): void
	{
		super.onAfterAttach(msg);
		this._buildUI();
		this._generateSyntheticGitHistory();
		this._renderD3Heatmap();
		this._openSkillsSidebar();
		this._fetchResumeData();
	}

	/**
	 * Spawns the ExhaustiveSkillsWidget as a sidebar panel inside the main DockPanel layout
	 */
	private _openSkillsSidebar(): void
	{
		const skillsWidget = widgetSelf.SkillsWidget?.getInstance();
		if(!widgetSelf.mainDock || !skillsWidget)
		{
			return;
		}
		// Check if layout adjuster and main dock panel exist globally

		if(!skillsWidget.isAttached)
		{
			widgetSelf.LayoutAdjuster?.addOptimalWidgetLayout(widgetSelf.mainDock, skillsWidget, {
				type: 'outline',
				projectId: skillsWidget.constructor.name
			});
		} else
		{
			skillsWidget.show();
		}
	}

	/**
	 * Asynchronously fetches the master resume dataset from server with abort timeout
	 */
	private async _fetchResumeData(): Promise<void>
	{
		this._resumeData = await ResumeWidget.getSharedResumeData();
		this._updateUI();
	}


	protected onResize(msg: Widget.ResizeMessage): void
	{
		super.onResize(msg);
		this._renderD3Heatmap();
	}

	public dispose(): void
	{
		ResumeWidget.instance = null;
		super.dispose();
	}

	public processMessage(msg: Message): void
	{
		if(msg.type === 'close-request')
		{
			widgetSelf.SkillsWidget?.getInstance().close();
		}
		super.processMessage(msg);
	}

	protected onActivateRequest(msg: Message): void
	{
		super.onActivateRequest(msg);
		this._openSkillsSidebar();
	}

	protected onAfterShow(msg: Message): void
	{
		super.onAfterShow(msg);
		this._openSkillsSidebar();
	}


	protected override onBeforeDetach(msg: Message): void
	{
		widgetSelf.SkillsWidget?.getInstance().close();
		super.onBeforeDetach(msg);
	}

	protected onBeforeHide(msg: Message): void
	{
		widgetSelf.SkillsWidget?.getInstance().close();
		super.onBeforeHide(msg);
	}

	private _buildUI(): void
	{
		this.node.replaceChildren();

		// Top Header
		const header = document.createElement('div');
		header.className = 'no-print';
		header.style.display = 'flex';
		header.style.flexWrap = 'wrap';
		header.style.justifyContent = 'space-between';
		header.style.alignItems = 'center';
		header.style.padding = '12px 18px';
		header.style.backgroundColor = '#18181a';
		header.style.borderBottom = '1px solid #2d2d30';

		console.log(this._resumeData);
		const profile = this._resumeData?.applicant_profile;

		if(profile?.full_name)
		{
			this.title.label = profile?.full_name;
			this.update();
		}

		const titleBox = document.createElement('div');
		titleBox.style.flexBasis = '80%';
		titleBox.innerHTML = `
            <div style="display:flex; align-items:center; gap:12px;">
                <span style="font-size:11px; color:#888;">${profile?.contact.location} | ${profile?.contact.phone} | ${profile?.contact.email}</span>
            </div>
            <div style="font-size:11px; color:#569cd6; margin-top:2px;">${profile?.headline}</div>
        `;

		//const controlsBox = document.createElement('div');
		//controlsBox.style.display = 'flex';
		//controlsBox.style.alignItems = 'center';
		//controlsBox.style.gap = '10px';

		this._filterBadgeEl = document.createElement('div');
		this._filterBadgeEl.style.fontSize = '11px';
		this._filterBadgeEl.style.padding = '3px 8px';
		this._filterBadgeEl.style.borderRadius = '3px';
		this._filterBadgeEl.style.backgroundColor = '#252526';
		this._filterBadgeEl.style.color = '#ce9178';
		this._filterBadgeEl.style.display = 'none';

		const printBtn = document.createElement('button');
		printBtn.style.flexBasis = '20%';
		printBtn.className = 'tab-btn';
		printBtn.innerHTML = '<i class="bx bx-printer"></i> Print Anthology (Ctrl+P)';
		printBtn.onclick = () => window.print();

		header.appendChild(titleBox);
		header.appendChild(printBtn);
		header.appendChild(this._filterBadgeEl);

		//header.appendChild(controlsBox);

		// Section Tabs Filter Bar
		this._navTabsContainerEl = document.createElement('div');
		this._navTabsContainerEl.className = 'no-print';
		this._navTabsContainerEl.style.display = 'flex';
		this._navTabsContainerEl.style.gap = '6px';
		this._navTabsContainerEl.style.padding = '8px 18px';
		this._navTabsContainerEl.style.backgroundColor = '#141416';
		this._navTabsContainerEl.style.borderBottom = '1px solid #252528';

		const sections: { id: 'all' | 'profile' | 'skills' | 'experience' | 'education' | 'sabbaticals'; label: string; }[] = [
			{ id: 'all', label: 'Show All Sections' },
			{ id: 'profile', label: 'Executive Profile & Federal' },
			{ id: 'skills', label: 'Skills & Tools Matrix' },
			{ id: 'experience', label: 'Employment History' },
			{ id: 'education', label: 'Education' },
			{ id: 'sabbaticals', label: 'Sabbaticals & Interests' }
		];

		sections.forEach(s =>
		{
			const btn = document.createElement('button');
			btn.className = `tab-btn ${this._activeSection === s.id ? 'active' : ''}`;
			btn.textContent = s.label;
			btn.onclick = () =>
			{
				this._activeSection = s.id;
				Array.from(this._navTabsContainerEl.children).forEach(c => c.classList.remove('active'));
				btn.classList.add('active');
				this._renderCards();
			};
			this._navTabsContainerEl.appendChild(btn);
		});

		// Scrollable Main Content Area
		const bodyScroll = document.createElement('div');
		bodyScroll.style.flex = '1';
		bodyScroll.style.overflowY = 'auto';
		bodyScroll.style.padding = '16px';
		bodyScroll.style.display = 'flex';
		bodyScroll.style.flexDirection = 'column';
		bodyScroll.style.gap = '16px';

		// Section 3: Floating Flash Cards Container
		this._cardsContainerEl = document.createElement('div');
		this._cardsContainerEl.id = 'cards-container';
		this._cardsContainerEl.style.display = 'flex';
		this._cardsContainerEl.style.flexDirection = 'column';
		this._cardsContainerEl.style.gap = '14px';

		//bodyScroll.appendChild(heatmapCard.wrapper);
		//bodyScroll.appendChild(skillsCard.wrapper);
		bodyScroll.appendChild(this._cardsContainerEl);

		this.node.appendChild(header);
		this.node.appendChild(this._navTabsContainerEl);
		this.node.appendChild(bodyScroll);
	}


	/**
	 * Updates header text, skills matrix, and flash cards when resume data resolves
	 */
	private _updateUI(): void
	{
		if(!this._resumeData) return;

		// Update Header Profile Info
		const profile = this._resumeData.applicant_profile;

		if(profile?.full_name)
		{
			this.title.label = profile?.full_name;
			this.update();
		}

		const headerTitleEl = this.node.querySelector('.no-print > div:first-child') as HTMLElement | null;
		if(headerTitleEl && profile)
		{
			headerTitleEl.innerHTML = `
                <div style="display:flex; align-items:center; gap:12px;">
                    <span style="font-size:11px; color:#888;">${profile.contact.location} | ${profile.contact.phone} | ${profile.contact.email}</span>
                </div>
                <div style="font-size:11px; color:#569cd6; margin-top:2px;">${profile.headline}</div>
            `;
		}

		// Re-render dependent sections
		this._renderCards();
	}



	private _createGlassCard(title: string | null | undefined, iconClass: string): { wrapper: HTMLElement; content: HTMLElement; }
	{
		const wrapper = document.createElement('div');
		wrapper.className = 'glass-card';
		wrapper.style.padding = '14px';
		const content = document.createElement('div');

		if(title)
		{
			const head = document.createElement('div');
			head.style.fontWeight = 'bold';
			head.style.fontSize = '13px';
			head.style.color = '#569cd6';
			head.style.display = 'flex';
			head.style.alignItems = 'center';
			head.style.gap = '8px';
			head.style.marginBottom = '10px';
			head.style.borderBottom = '1px solid rgba(255, 255, 255, 0.05)';
			head.style.paddingBottom = '6px';
			head.innerHTML = `<i class="${iconClass}"></i> <span class="print-text-dark">${title}</span>`;


			wrapper.appendChild(head);
		}

		wrapper.appendChild(content);

		return { wrapper, content };
	}

	private _generateSyntheticGitHistory(): void
	{
		this._gitEvents = [];
		const end = new Date();
		const start = new Date(end.getFullYear() - 1, 0, 1);

		for(let d = new Date(start); d <= end; d.setDate(d.getDate() + 1))
		{
			const dayOfWeek = d.getDay();
			if(dayOfWeek !== 0 && Math.random() > 0.35)
			{
				const count = Math.floor(Math.random() * 5) + 1;
				for(let c = 0; c < count; c++)
				{
					this._gitEvents.push({
						start: new Date(d),
						end: new Date(d.getTime() + 1000 * 60 * 60 * 2)
					});
				}
			}
		}
	}



	/**
		 * Parses a period string (e.g. "2021 - Present", "May 2018 - Dec 2020", "2016")
		 * to extract structured start/end years and 'isPresent' state for sorting.
		 */
	private _parsePeriod(periodStr?: string): { startYear: number; endYear: number; isPresent: boolean; }
	{
		if(!periodStr) return { startYear: 0, endYear: 0, isPresent: false };

		const isPresent = /present/i.test(periodStr);
		const currentYear = new Date().getFullYear();
		const years = periodStr.match(/\b(19|20)\d{2}\b/g)?.map(Number) || [];

		let startYear = 0;
		let endYear = 0;

		if(years.length >= 2)
		{
			startYear = years[0];
			endYear = isPresent ? currentYear : years[1];
		} else if(years.length === 1)
		{
			startYear = years[0];
			endYear = isPresent ? currentYear : years[0];
		}

		return { startYear, endYear, isPresent };
	}


	/**
	 * Renders a single-year D3 Git Heatmap into a target SVG element
	 */
	private _renderD3HeatmapForYear(svgEl: SVGSVGElement, year: number): void
	{
		if(typeof d3 === 'undefined' || !svgEl) return;

		const svg = d3.select(svgEl);
		svg.selectAll('*').remove();

		const containerWidth = svgEl.clientWidth || 900;
		const containerHeight = svgEl.clientHeight || 120;

		const margin = { top: 15, right: 20, bottom: 15, left: 35 };
		const innerWidth = containerWidth - margin.left - margin.right;
		const innerHeight = containerHeight - margin.top - margin.bottom;

		// Configure SVG attributes for scaling
		svg.attr('viewBox', `0 0 ${containerWidth} ${containerHeight}`)
			.attr('preserveAspectRatio', 'none');

		// Dynamic step sizing (X stretches across 54 weeks, Y stretches across 7 days)
		const stepX = innerWidth / 54;
		const stepY = innerHeight / 7;

		const dayLength = 60 * 60 * 24;

		const dayCounts: Record<number, number> = {};
		for(const ev of this._gitEvents)
		{
			if(ev.start.getFullYear() === year)
			{
				const dayKey = Math.floor(ev.start.getTime() / (1000 * dayLength)) * dayLength;
				dayCounts[dayKey] = (dayCounts[dayKey] || 0) + (ev.end.getTime() - ev.start.getTime());
			}
		}

		const colorScale = d3.scaleLinear<string>()
			.range(['#1b1b3a', '#007acc', '#4ec9b0'])
			.domain([0, 5000000, 10000000]);

		const rootG = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
		const yearG = rootG.append('g').attr('transform', `translate(20, 0)`);

		yearG.append('text')
			.text(year)
			.attr('fill', '#888')
			.attr('font-size', '10px')
			.attr('transform', `translate(-25, ${stepY * 3.5}) rotate(-90)`)
			.attr('text-anchor', 'middle');

		const daysInYear = d3.timeDays(new Date(year, 0, 1), new Date(year + 1, 0, 1));

		yearG.selectAll('.day')
			.data(daysInYear)
			.enter().append('rect')
			.attr('class', 'day')
			.attr('width', Math.max(1, stepX - 1))
			.attr('height', Math.max(1, stepY - 1))
			.attr('x', (d: Date) => parseInt(d3.timeFormat('%W')(d)) * stepX)
			.attr('y', (d: Date) => ((d.getDay() + 6) % 7) * stepY)
			.attr('fill', (d: Date) =>
			{
				const key = Math.floor(d.getTime() / (1000 * dayLength)) * dayLength;
				const val = dayCounts[key];
				return val ? colorScale(val) : '#222';
			})
			.attr('rx', 2)
			.append('title')
			.text((d: Date) => `${d3.timeFormat('%Y-%m-%d')(d)}: Activity Recorded`);
	}


	private _renderD3Heatmap(): void
	{
		// Primary single-year heatmap call wrapper (re-rendered during cards layout pass)
		const currentYear = new Date().getFullYear();
		if(this._heatmapSvgEl)
		{
			this._renderD3HeatmapForYear(this._heatmapSvgEl, currentYear);
		}
	}

	/**
	 * Scans the full master resume dataset across all sections to find
	 * the absolute earliest start year, ensuring heatmap flush loops
	 * never terminate early when filtering section views.
	 */
	private _getGlobalEarliestStartYear(): number
	{
		const currentYear = new Date().getFullYear();
		if(!this._resumeData) return currentYear;

		let earliestYear = currentYear;

		// Scan Employment
		this._resumeData.employment_history?.forEach(emp =>
		{
			const p = this._parsePeriod(emp.period);
			if(p.startYear && p.startYear < earliestYear) earliestYear = p.startYear;
		});

		// Scan Education
		this._resumeData.education?.forEach(edu =>
		{
			const periodStr = (edu as any).period || `${edu.graduation_year}`;
			const p = this._parsePeriod(periodStr);
			if(p.startYear && p.startYear < earliestYear) earliestYear = p.startYear;
		});

		// Scan Sabbaticals & Extracurriculars
		this._resumeData.extracurricular_and_sabbaticals?.forEach(sab =>
		{
			const periodStr = (sab as any).period || sab.duration;
			const p = this._parsePeriod(periodStr);
			if(p.startYear && p.startYear < earliestYear) earliestYear = p.startYear;
		});

		return earliestYear;
	}

	private _renderCards(): void
	{
		if(!this._cardsContainerEl) return;
		this._cardsContainerEl.replaceChildren();

		let currentYearBlock: number | null = (new Date).getFullYear();
		const shouldShowHeatmaps = (this._activeSection === 'all' || this._activeSection === 'profile' || this._activeSection === 'experience');

		// Helper to append a year-specific heatmap card
		const appendHeatmapCardForYear = (year: number) =>
		{
			const heatmapCard = this._createGlassCard(`Work Activity — Year of ${year}`, 'bx bx-calendar');
			heatmapCard.wrapper.classList.add('no-print', 'resume-entry-card', 'year-heatmap-card');

			const yearSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			yearSvg.style.width = '100%';
			yearSvg.style.height = '100%';
			yearSvg.style.minHeight = '80px';

			heatmapCard.content.appendChild(yearSvg);
			this._cardsContainerEl.appendChild(heatmapCard.wrapper);

			this._renderD3HeatmapForYear(yearSvg, year);
		};

		if(shouldShowHeatmaps)
		{
			appendHeatmapCardForYear(currentYearBlock);
			currentYearBlock--;
		}

		// 1. Render Top Executive Profile Card
		if(this._activeSection === 'all' || this._activeSection === 'profile')
		{
			const prof = this._resumeData?.applicant_profile;
			const profCard = this._createGlassCard(null, 'bx bx-user');
			profCard.wrapper.className += ' resume-entry-card resume-entry-card-profile';
			profCard.content.innerHTML += `
                <div style="font-size:12px; line-height:1.5; color:#ccc; margin-bottom:10px;" class="print-text-dark">
                    <i class="bx bx-user"></i> ${prof?.executive_summary}
                </div>
                <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:8px; font-size:11px; background:rgba(0,0,0,0.2); padding:8px; border-radius:4px;" class="glass-card">
                    <div><strong style="color:#569cd6;">Citizenship:</strong> ${prof?.federal_metadata.citizenship}</div>
                    <div><strong style="color:#569cd6;">Hiring Authority:</strong> ${prof?.federal_metadata.special_hiring_authority}</div>
                    <div><strong style="color:#569cd6;">Clearance:</strong> ${prof?.federal_metadata.clearance}</div>
                    <div style="grid-column: 1 / -1;"><strong style="color:#4ec9b0;">Objective:</strong> ${prof?.federal_metadata.objective}</div>
                </div>
            `;
			this._cardsContainerEl.appendChild(profCard.wrapper);
		}

		// 2. Normalize and Pool All Timeline Entries Across Sections
		interface IUnifiedTimelineEntry
		{
			type: 'experience' | 'education' | 'sabbaticals';
			title: string;
			iconClass: string;
			location?: string;
			period: string;
			narrative?: string;
			highlights?: string[];
			related_skills?: string[];
			parsedPeriod: { startYear: number; endYear: number; isPresent: boolean; };
		}

		const unifiedEntries: IUnifiedTimelineEntry[] = [];

		// Ingest Employment
		if(this._activeSection === 'all' || this._activeSection === 'experience' || this._activeSection === 'skills')
		{
			this._resumeData?.employment_history.forEach(emp =>
			{
				unifiedEntries.push({
					type: 'experience',
					title: `${emp.role} — ${emp.company}`,
					iconClass: 'bx bx-briefcase-alt',
					location: emp.location,
					period: emp.period,
					narrative: emp.narrative,
					highlights: emp.highlights,
					related_skills: emp.related_skills,
					parsedPeriod: this._parsePeriod(emp.period)
				});
			});
		}

		// Ingest Education
		if(this._activeSection === 'all' || this._activeSection === 'education')
		{
			this._resumeData?.education.forEach(edu =>
			{
				const periodStr = (edu as any).period || `${edu.graduation_year}`;
				const locationStr = (edu as any).location || 'Flagstaff, AZ';
				const narrativeStr = (edu as any).narrative || `Graduated: ${edu.graduation_year} | GPA: ${edu.gpa}\n${edu.details}`;
				unifiedEntries.push({
					type: 'education',
					title: `${edu.degree} — ${edu.institution}`,
					iconClass: 'bx bx-education',
					location: locationStr,
					period: periodStr,
					narrative: narrativeStr,
					highlights: edu.relevant_coursework,
					related_skills: (edu as any).related_skills || [],
					parsedPeriod: this._parsePeriod(periodStr)
				});
			});
		}

		// Ingest Sabbaticals & Construction
		if(this._activeSection === 'all' || this._activeSection === 'sabbaticals')
		{
			this._resumeData?.extracurricular_and_sabbaticals.forEach(sab =>
			{
				const periodStr = (sab as any).period || sab.duration;
				const locationStr = (sab as any).location || 'Flagstaff, AZ';
				const narrativeStr = (sab as any).narrative || sab.details;
				unifiedEntries.push({
					type: 'sabbaticals',
					title: sab.title,
					iconClass: 'bx bx-globe',
					location: locationStr,
					period: periodStr,
					narrative: narrativeStr,
					highlights: (sab as any).highlights || [],
					related_skills: (sab as any).related_skills || [],
					parsedPeriod: this._parsePeriod(periodStr)
				});
			});
		}

		// 3. Chronological Sort Strategy
		unifiedEntries.sort((a, b) =>
		{
			const pA = a.parsedPeriod;
			const pB = b.parsedPeriod;

			if(pA.endYear !== pB.endYear)
			{
				return pB.endYear - pA.endYear;
			}

			if(pA.isPresent !== pB.isPresent)
			{
				return pA.isPresent ? 1 : -1;
			}

			return pB.startYear - pA.startYear;
		});

		// 4. Render Entries and Append Heatmap at the Bottom of Each Year Block

		unifiedEntries.forEach((entry, index) =>
		{
			const entryYear = entry.parsedPeriod.endYear || entry.parsedPeriod.startYear;

			// Track year initialization
			if(currentYearBlock === null)
			{
				currentYearBlock = entryYear;
			}

			// When stepping down to an older year, flush heatmaps for all skipped years in reverse countdown
			if(shouldShowHeatmaps && currentYearBlock !== null && entryYear < currentYearBlock)
			{
				for(let y = currentYearBlock; y > entryYear; y--)
				{
					appendHeatmapCardForYear(y);
				}
				currentYearBlock = entryYear;
			}

			// Render Card
			const card = this._createGlassCard(entry.title, entry.iconClass);
			card.wrapper.className += ` resume-entry-card resume-entry-card-${index}`;
			card.wrapper.setAttribute('data-tags', JSON.stringify(entry.related_skills || []));

			const subHead = document.createElement('div');
			subHead.style.display = 'flex';
			subHead.style.justifyContent = 'space-between';
			subHead.style.fontSize = '11px';
			subHead.style.color = '#ce9178';
			subHead.style.marginBottom = '6px';
			subHead.innerHTML = `<span>${entry.location || ''}</span><span>${entry.period}</span>`;

			card.content.appendChild(subHead);

			if(entry.narrative)
			{
				const narrative = document.createElement('div');
				narrative.className = 'print-text-dark';
				narrative.style.fontSize = '11px';
				narrative.style.fontStyle = 'italic';
				narrative.style.color = '#aaa';
				narrative.style.marginBottom = '8px';
				narrative.textContent = entry.narrative;
				card.content.appendChild(narrative);
			}

			if(entry.highlights && entry.highlights.length > 0 && this._activeSection !== 'skills')
			{
				const ul = document.createElement('ul');
				ul.style.margin = '0 0 10px 18px';
				ul.style.padding = '0';
				ul.style.fontSize = '11px';
				ul.style.color = '#ddd';

				entry.highlights.forEach(h =>
				{
					const li = document.createElement('li');
					li.className = 'print-text-dark';
					li.style.marginBottom = '3px';
					li.textContent = h;
					ul.appendChild(li);
				});
				card.content.appendChild(ul);
			}

			if(entry.related_skills && entry.related_skills.length > 0)
			{
				const tagsBox = document.createElement('div');
				tagsBox.style.display = 'flex';
				tagsBox.style.flexWrap = 'wrap';
				tagsBox.style.gap = '4px';

				entry.related_skills.forEach(skill =>
				{
					const badge = document.createElement('span');
					badge.className = 'print-badge';
					badge.style.fontSize = '9px';
					badge.style.padding = '1px 5px';
					badge.style.borderRadius = '2px';
					badge.style.backgroundColor = '#252526';
					badge.style.color = '#4ec9b0';
					badge.style.border = '1px solid #3c3c3c';
					badge.textContent = skill;
					tagsBox.appendChild(badge);
				});
				card.content.appendChild(tagsBox);
			}

			this._cardsContainerEl.appendChild(card.wrapper);
		});

		// 5. Tail Flush: Emit heatmaps from the oldest rendered block down to the global dataset minimum year
		if(shouldShowHeatmaps && currentYearBlock !== null)
		{
			const globalEarliestYear = this._getGlobalEarliestStartYear();
			for(let y = currentYearBlock; y >= globalEarliestYear; y--)
			{
				appendHeatmapCardForYear(y);
			}
		}
	}
}

widgetSelf.ResumeWidget = ResumeWidget;
