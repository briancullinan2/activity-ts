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
}

export interface IExtracurricularEntry
{
	title: string;
	duration: string;
	details: string;
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

		// Check if layout adjuster and main dock panel exist globally
		const globalSelf = self as unknown as { mainDock?: any; };
		if(globalSelf.mainDock && skillsWidget && !skillsWidget.isAttached)
		{
			widgetSelf.LayoutAdjuster?.addOptimalWidgetLayout(globalSelf.mainDock, skillsWidget, {
				type: 'outline',
				projectId: skillsWidget.constructor.name
			});
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
			{ id: 'sabbaticals', label: 'Sabbaticals & Construction' }
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

	private _renderD3Heatmap(): void
	{
		if(typeof d3 === 'undefined' || !this._heatmapSvgEl) return;

		const svg = d3.select(this._heatmapSvgEl);
		svg.selectAll('*').remove();

		const width = this._heatmapSvgEl.clientWidth || 900;
		const margin = { top: 15, right: 20, bottom: 15, left: 35 };

		const endYear = new Date().getFullYear();
		const startYear = endYear - 1;
		const years = [endYear, startYear];

		const dayLength = 60 * 60 * 24;
		const sizeByDay = Math.min(12, (width - margin.left - margin.right) / 54);

		const dayCounts: Record<number, number> = {};
		for(const ev of this._gitEvents)
		{
			const dayKey = Math.floor(ev.start.getTime() / (1000 * dayLength)) * dayLength;
			dayCounts[dayKey] = (dayCounts[dayKey] || 0) + (ev.end.getTime() - ev.start.getTime());
		}

		const colorScale = d3.scaleLinear<string>()
			.range(['#1b1b3a', '#007acc', '#4ec9b0'])
			.domain([0, 5000000, 10000000]);

		const rootG = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

		years.forEach((y, i) =>
		{
			const yearG = rootG.append('g')
				.attr('transform', `translate(20, ${i * (sizeByDay * 8 + 14)})`);

			yearG.append('text')
				.text(y)
				.attr('fill', '#888')
				.attr('font-size', '10px')
				.attr('transform', `translate(-25, ${sizeByDay * 3.5}) rotate(-90)`)
				.attr('text-anchor', 'middle');

			const daysInYear = d3.timeDays(new Date(y, 0, 1), new Date(y + 1, 0, 1));

			yearG.selectAll('.day')
				.data(daysInYear)
				.enter().append('rect')
				.attr('class', 'day')
				.attr('width', sizeByDay - 1)
				.attr('height', sizeByDay - 1)
				.attr('x', (d: Date) => parseInt(d3.timeFormat('%W')(d)) * sizeByDay)
				.attr('y', (d: Date) => ((d.getDay() + 6) % 7) * sizeByDay)
				.attr('fill', (d: Date) =>
				{
					const key = Math.floor(d.getTime() / (1000 * dayLength)) * dayLength;
					const val = dayCounts[key];
					return val ? colorScale(val) : '#222';
				})
				.attr('rx', 2)
				.append('title')
				.text((d: Date) => `${d3.timeFormat('%Y-%m-%d')(d)}: Activity Recorded`);
		});
	}

	private _renderCards(): void
	{
		if(!this._cardsContainerEl) return;
		this._cardsContainerEl.replaceChildren();


		if(this._activeSection === 'all')
		{
			// Section 1: Client-Side D3 Git Commit Heatmap
			const heatmapCard = this._createGlassCard('Engineering Activity & Commit Visualizer (Client-Side D3)', 'bx bx-calendar');
			heatmapCard.wrapper.classList.add('no-print');
			this._heatmapSvgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
			this._heatmapSvgEl.style.width = '100%';
			this._heatmapSvgEl.style.height = '140px';
			heatmapCard.content.appendChild(this._heatmapSvgEl);
			this._cardsContainerEl.appendChild(heatmapCard.wrapper);
			this._generateSyntheticGitHistory();
			this._renderD3Heatmap();
		}

		// 1. Executive Profile & Federal Metadata Card
		if(this._activeSection === 'all' || this._activeSection === 'profile')
		{
			const prof = this._resumeData?.applicant_profile;
			const profCard = this._createGlassCard(null, 'bx bx-user');
			profCard.wrapper.className += ' resume-entry-card';
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

		// 2. Employment Experience Cards
		if(this._activeSection === 'all' || this._activeSection === 'experience')
		{
			this._resumeData?.employment_history.forEach(emp =>
			{
				const card = this._createGlassCard(`${emp.role} — ${emp.company}`, 'bx bx-briefcase');
				card.wrapper.className += ' resume-entry-card';
				card.wrapper.setAttribute('data-tags', JSON.stringify(emp.related_skills));

				const subHead = document.createElement('div');
				subHead.style.display = 'flex';
				subHead.style.justifyContent = 'space-between';
				subHead.style.fontSize = '11px';
				subHead.style.color = '#ce9178';
				subHead.style.marginBottom = '6px';
				subHead.innerHTML = `<span>${emp.location}</span><span>${emp.period}</span>`;

				const narrative = document.createElement('div');
				narrative.className = 'print-text-dark';
				narrative.style.fontSize = '11px';
				narrative.style.fontStyle = 'italic';
				narrative.style.color = '#aaa';
				narrative.style.marginBottom = '8px';
				narrative.textContent = emp.narrative;

				const ul = document.createElement('ul');
				ul.style.margin = '0 0 10px 18px';
				ul.style.padding = '0';
				ul.style.fontSize = '11px';
				ul.style.color = '#ddd';

				emp.highlights.forEach(h =>
				{
					const li = document.createElement('li');
					li.className = 'print-text-dark';
					li.style.marginBottom = '3px';
					li.textContent = h;
					ul.appendChild(li);
				});

				const tagsBox = document.createElement('div');
				tagsBox.style.display = 'flex';
				tagsBox.style.flexWrap = 'wrap';
				tagsBox.style.gap = '4px';

				emp.related_skills.forEach(skill =>
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

				card.content.appendChild(subHead);
				card.content.appendChild(narrative);
				card.content.appendChild(ul);
				card.content.appendChild(tagsBox);

				this._cardsContainerEl.appendChild(card.wrapper);
			});
		}

		// 3. Education Card
		if(this._activeSection === 'all' || this._activeSection === 'education')
		{
			this._resumeData?.education.forEach(edu =>
			{
				const eduCard = this._createGlassCard(`${edu.degree} — ${edu.institution}`, 'bx bx-education');
				eduCard.wrapper.className += ' resume-entry-card';
				eduCard.content.innerHTML = `
                    <div style="font-size:11px; color:#888; margin-bottom:6px;">Graduated: ${edu.graduation_year} | GPA: ${edu.gpa}</div>
                    <div style="font-size:11px; font-weight:bold; color:#569cd6; margin-bottom:4px;">Relevant Coursework:</div>
                    <div style="display:flex; flex-wrap:wrap; gap:4px;">
                        ${edu.relevant_coursework.map(c => `<span class="print-badge" style="font-size:9px; padding:2px 6px; background:#252526; color:#dcdcaa; border-radius:2px;">${c}</span>`).join('')}
                    </div>
                `;
				this._cardsContainerEl.appendChild(eduCard.wrapper);
			});
		}

		// 4. Sabbaticals & General Contracting Card
		if(this._activeSection === 'all' || this._activeSection === 'sabbaticals')
		{
			this._resumeData?.extracurricular_and_sabbaticals.forEach(sab =>
			{
				const sabCard = this._createGlassCard(`${sab.title} (${sab.duration})`, 'bx bx-globe');
				sabCard.wrapper.className += ' resume-entry-card';
				sabCard.content.innerHTML = `
                    <div style="font-size:11px; line-height:1.4; color:#ccc;" class="print-text-dark">${sab.details}</div>
                `;
				this._cardsContainerEl.appendChild(sabCard.wrapper);
			});
		}
	}

}

widgetSelf.ResumeWidget = ResumeWidget;
