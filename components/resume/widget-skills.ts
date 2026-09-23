import { Widget } from '@lumino/widgets';
import { Message, MessageLoop } from '@lumino/messaging';
import type { ISkillMetric, IFullResumeData, ResumeWidget } from './widget';

const widgetSelf = self as unknown as & {
	ResumeWidget?: typeof ResumeWidget;
	SkillsWidget?: typeof SkillsWidget;
};

export class SkillsWidget extends Widget
{
	public static instance: SkillsWidget | null = null;
	private _resumeData?: IFullResumeData;
	private _skillsContainerEl!: HTMLDivElement;

	constructor()
	{
		if(SkillsWidget.instance)
		{
			return SkillsWidget.instance;
		}

		super();
		this.addClass('lm-SkillsWidget');
		this.id = 'exhaustive-skills-widget';

		this.node.style.overflowY = 'auto';
		this.node.style.display = 'flex';
		this.node.style.flexDirection = 'column';
		this.node.style.height = '100%';
		this.node.style.width = '100%';
		this.node.style.backgroundColor = '#121214';
		this.node.style.color = '#e1e1e6';
		this.node.style.padding = '12px';
		this.node.style.boxSizing = 'border-box';
		this.node.style.fontFamily = 'Consolas, "Courier New", monospace';

		this.title.label = 'Skills';
		this.title.iconClass = 'fa fa-bar-chart';
		this.title.closable = true;

		SkillsWidget.instance = this;
	}

	public processMessage(msg: Message): void
	{
		if(msg.type === 'close-request')
		{
			console.log('Intercepted close request, hiding instead: ' + this.title.label);
			// Hijack the close! Instead of destroying, hide the panel
			this.hide();
			this.parent = null;

			// Notify the parent DockPanel to recalculate layout paths immediately
			if(this.parent)
			{
				// Forcing an internal update pass so layout sizes collapse seamlessly
				MessageLoop.sendMessage(this.parent, new Message('layout-request'));
			}
			return; // BAIL OUT: Avoid calling super.processMessage() to prevent disposal
		}

		super.processMessage(msg);
	}


	public static getInstance(): SkillsWidget
	{
		if(!SkillsWidget.instance || SkillsWidget.instance.isDisposed)
		{
			SkillsWidget.instance = new SkillsWidget();
		}
		return SkillsWidget.instance;
	}

	protected onAfterAttach(msg: Message): void
	{
		super.onAfterAttach(msg);

		this._buildUI();
		this._loadResumeData();
	}

	private async _loadResumeData(): Promise<void>
	{
		// Dynamically reference ResumeWidget static request cache
		const windowSelf = self as unknown as { ResumeWidget?: typeof import('./widget').ResumeWidget; };
		if(windowSelf.ResumeWidget)
		{
			const data = await windowSelf.ResumeWidget.getSharedResumeData();
			if(data)
			{
				this._resumeData = data;
				this._renderSkillsChart();
			}
		}
	}

	private _buildUI(): void
	{
		this.node.replaceChildren();

		const titleHeader = document.createElement('div');
		titleHeader.style.fontSize = '13px';
		titleHeader.style.fontWeight = 'bold';
		titleHeader.style.color = '#569cd6';
		titleHeader.style.marginBottom = '12px';
		titleHeader.style.paddingBottom = '6px';
		titleHeader.style.borderBottom = '1px solid rgba(255, 255, 255, 0.08)';
		titleHeader.innerHTML = '<i class="fa fa-sliders"></i> Exhaustive Skills Matrix';

		this._skillsContainerEl = document.createElement('div');
		this._skillsContainerEl.style.display = 'flex';
		this._skillsContainerEl.style.flexDirection = 'column';
		this._skillsContainerEl.style.gap = '10px';

		this.node.appendChild(titleHeader);
		this.node.appendChild(this._skillsContainerEl);
	}

	private _renderSkillsChart(): void
	{
		if(!this._skillsContainerEl || !this._resumeData) return;
		this._skillsContainerEl.replaceChildren();

		const matrix = this._resumeData.skills_and_technologies_matrix;

		// Core Languages
		const langHead = document.createElement('div');
		langHead.style.fontSize = '11px';
		langHead.style.fontWeight = 'bold';
		langHead.style.color = '#ce9178';
		langHead.style.margin = '4px 0';
		langHead.textContent = 'Core Languages & Proficiencies';
		this._skillsContainerEl.appendChild(langHead);

		const langGrid = document.createElement('div');
		langGrid.style.display = 'grid';
		langGrid.style.gridTemplateColumns = '1fr';
		langGrid.style.gap = '6px';

		for(const item of matrix?.core_languages ?? [])
		{
			langGrid.appendChild(this._createSkillBar(item));
		}
		this._skillsContainerEl.appendChild(langGrid);

		// Core Skills
		const skillsHead = document.createElement('div');
		skillsHead.style.fontSize = '11px';
		skillsHead.style.fontWeight = 'bold';
		skillsHead.style.color = '#4ec9b0';
		skillsHead.style.margin = '10px 0 4px 0';
		skillsHead.textContent = 'Engineering Competencies (Years)';
		this._skillsContainerEl.appendChild(skillsHead);

		const skillGrid = document.createElement('div');
		skillGrid.style.display = 'grid';
		skillGrid.style.gridTemplateColumns = '1fr';
		skillGrid.style.gap = '6px';

		for(const item of matrix?.skills ?? [])
		{
			skillGrid.appendChild(this._createSkillBar(item));
		}
		this._skillsContainerEl.appendChild(skillGrid);

		// Advanced Specializations
		const specHead = document.createElement('div');
		specHead.style.fontSize = '11px';
		specHead.style.fontWeight = 'bold';
		specHead.style.color = '#569cd6';
		specHead.style.margin = '10px 0 4px 0';
		specHead.textContent = 'Specializations';
		this._skillsContainerEl.appendChild(specHead);

		const specBox = document.createElement('div');
		specBox.style.display = 'flex';
		specBox.style.flexWrap = 'wrap';
		specBox.style.gap = '4px';

		matrix?.advanced_frameworks_and_specializations.forEach(spec =>
		{
			const tag = document.createElement('span');
			tag.style.fontSize = '10px';
			tag.style.padding = '2px 6px';
			tag.style.borderRadius = '3px';
			tag.style.backgroundColor = '#252526';
			tag.style.color = '#dcdcaa';
			tag.style.border = '1px solid #3c3c3c';
			tag.style.cursor = 'pointer';
			tag.textContent = spec;

			tag.addEventListener('mouseenter', () => this._filterTimelineBySkill(spec));
			tag.addEventListener('mouseleave', () => this._clearTimelineFilter());

			specBox.appendChild(tag);
		});
		this._skillsContainerEl.appendChild(specBox);
	}

	private _createSkillBar(item: ISkillMetric): HTMLElement
	{
		const barBox = document.createElement('div');
		barBox.style.padding = '5px 8px';
		barBox.style.backgroundColor = 'rgba(20, 20, 22, 0.6)';
		barBox.style.border = '1px solid rgba(255, 255, 255, 0.05)';
		barBox.style.borderRadius = '4px';
		barBox.style.cursor = 'pointer';

		const labelRow = document.createElement('div');
		labelRow.style.display = 'flex';
		labelRow.style.justifyContent = 'space-between';
		labelRow.style.fontSize = '10px';
		labelRow.style.marginBottom = '3px';

		const nameSpan = document.createElement('span');
		nameSpan.style.color = item.category === 'skill' ? '#4ec9b0' : item.category === 'core_language' ? '#ce9178' : '#569cd6';
		nameSpan.style.fontWeight = 'bold';
		nameSpan.textContent = item.name;

		const yearsSpan = document.createElement('span');
		yearsSpan.style.color = '#888';
		yearsSpan.textContent = item.proficiency ? `${item.proficiency} (${item.years}y)` : `${item.years} yrs`;

		labelRow.appendChild(nameSpan);
		labelRow.appendChild(yearsSpan);

		const track = document.createElement('div');
		track.style.height = '4px';
		track.style.backgroundColor = '#252526';
		track.style.borderRadius = '2px';
		track.style.overflow = 'hidden';

		const fill = document.createElement('div');
		fill.style.height = '100%';
		fill.style.width = `${Math.min(100, (item.years / 23) * 100)}%`;
		fill.style.backgroundColor = item.category === 'skill' ? '#4ec9b0' : item.category === 'core_language' ? '#ce9178' : '#007acc';

		track.appendChild(fill);
		barBox.appendChild(labelRow);
		barBox.appendChild(track);

		barBox.addEventListener('mouseenter', () => this._filterTimelineBySkill(item.name));
		barBox.addEventListener('mouseleave', () => this._clearTimelineFilter());

		return barBox;
	}

	public dispose(): void
	{
		SkillsWidget.instance = null;
		super.dispose();
	}


	private _filterTimelineBySkill(skillName: string): void
	{
		const that = widgetSelf.ResumeWidget?.getInstance();
		if(that)
		{
			that._activeFilter = skillName;
		}
		if(that?._filterBadgeEl)
		{
			that._filterBadgeEl.style.display = 'block';
			that._filterBadgeEl.textContent = `Filtering Timeline: ${skillName}`;
		}

		const cards = Array.from(that?.node.querySelectorAll('.resume-entry-card') ?? []) as HTMLElement[];
		for(const card of cards)
		{
			const tags: string[] = JSON.parse(card.getAttribute('data-tags') || '[]');
			const matches = tags.some(t => t.toLowerCase().includes(skillName.toLowerCase()) || skillName.toLowerCase().includes(t.toLowerCase()));

			if(matches)
			{
				card.style.opacity = '1';
				card.style.transform = 'scale(1.01)';
				card.style.margin = '0';
				card.style.borderColor = '#4ec9b0';
			} else
			{
				card.style.opacity = '0.2';
				card.style.transform = 'scaleX(0.9) scaleY(0.5)';
				card.style.margin = '-12.5% 0 -12.5% 0';
				card.style.borderColor = 'rgba(255, 255, 255, 0.08)';
			}
		}
	}

	private _clearTimelineFilter(): void
	{
		const that = widgetSelf.ResumeWidget?.getInstance();
		if(that)
		{
			that._activeFilter = null;
		}
		if(that?._filterBadgeEl)
		{
			that._filterBadgeEl.style.display = 'none';
		}

		const cards = Array.from(that?.node.querySelectorAll('.resume-entry-card') ?? []) as HTMLElement[];
		for(const card of cards)
		{
			card.style.opacity = '1';
			card.style.transform = 'scale(1)';
			card.style.margin = '0';
			card.style.borderColor = 'rgba(255, 255, 255, 0.08)';
		}
	}
}

widgetSelf.SkillsWidget = SkillsWidget;
