import { Widget } from '@lumino/widgets';
import { Message } from '@lumino/messaging';
import * as d3 from 'd3';
import d3Cloud from 'd3-cloud';
import type { IBlogAggregateData, IBlogPost, ITagWeight } from './generate';

export class BlogWidget extends Widget
{
	private _data: IBlogAggregateData | null = null;
	private _filteredPosts: IBlogPost[] = [];
	private _currentlyRenderedCount = 0;
	private _pageSize = 3; // Infinite scroll batch size
	private _activeTagFilter: string | null = null;
	private _activeYearFilter: number | null = null;
	private _activeMonthFilter: number | null = null; // 1-12
	private _searchQuery = '';

	private _archiveNavContainer!: HTMLDivElement;
	private _tagCloudContainer!: HTMLDivElement;
	private _scrollContainer!: HTMLDivElement;
	private _postsStreamContainer!: HTMLDivElement;
	private _loadingSpinner!: HTMLDivElement;
	private _filterBadge!: HTMLSpanElement;

	constructor()
	{
		super();
		this.addClass('blog-widget-root');
		this.id = 'lumino-blog-widget';
		this.title.label = 'Blog & Insights';
		this.title.closable = true;

		this._buildWidgetLayout();
	}

	private _buildWidgetLayout(): void
	{
		while(this.node.firstChild)
		{
			this.node.removeChild(this.node.firstChild);
		}

		// 1. Archive Date Filter Bar (Years & Months)
		this._archiveNavContainer = document.createElement('div');
		this._archiveNavContainer.className = 'blog-archive-nav';

		// 2. Active Filter Badge Indicator
		this._filterBadge = document.createElement('span');
		this._filterBadge.className = 'blog-filter-badge';
		this._filterBadge.style.display = 'none';

		// 3. D3 Tag Cloud Container
		this._tagCloudContainer = document.createElement('div');
		this._tagCloudContainer.className = 'blog-tag-cloud-wrapper';

		// 4. Infinite Scroll Area
		this._scrollContainer = document.createElement('div');
		this._scrollContainer.className = 'blog-scroll-container';
		this._scrollContainer.addEventListener('scroll', () => this._onScrollCheck());

		this._postsStreamContainer = document.createElement('div');
		this._postsStreamContainer.className = 'blog-posts-stream';

		this._loadingSpinner = document.createElement('div');
		this._loadingSpinner.className = 'blog-loading-indicator';
		this._loadingSpinner.textContent = 'Loading more posts...';

		this._scrollContainer.appendChild(this._postsStreamContainer);
		this._scrollContainer.appendChild(this._loadingSpinner);

		this.node.appendChild(this._archiveNavContainer);
		this.node.appendChild(this._filterBadge);
		this.node.appendChild(this._tagCloudContainer);
		this.node.appendChild(this._scrollContainer);
	}

	protected onAfterAttach(msg: Message): void
	{
		super.onAfterAttach(msg);
		this.loadData();
	}

	public async loadData(): Promise<void>
	{
		try
		{
			const response = await fetch('/components/blog/data/blog-data.json');
			this._data = await response.json();
			this._renderYearsAndMonthsNav();
			this._applyFiltersAndReset();
			this._renderD3WordCloud();
		}
		catch(err)
		{
			console.error('Failed to load blog aggregate data:', err);
		}
	}

	/**
	 * Aggregates unique years and months from _data.posts and populates the filter toolbar
	 */
	private _renderYearsAndMonthsNav(): void
	{
		if(!this._data || !this._data.posts.length) return;

		while(this._archiveNavContainer.firstChild)
		{
			this._archiveNavContainer.removeChild(this._archiveNavContainer.firstChild);
		}

		// Extract and group available dates { [year]: Set(months) }
		const yearMonthMap = new Map<number, Set<number>>();

		this._data.posts.forEach(post =>
		{
			const d = new Date(post.date);
			const year = d.getFullYear();
			const month = d.getMonth() + 1; // 1-indexed

			if(!yearMonthMap.has(year))
			{
				yearMonthMap.set(year, new Set());
			}
			yearMonthMap.get(year)!.add(month);
		});

		const sortedYears = Array.from(yearMonthMap.keys()).sort((a, b) => b - a);

		// "All Posts" reset button
		const allBtn = document.createElement('button');
		allBtn.className = `archive-pill ${this._activeYearFilter === null ? 'active' : ''}`;
		allBtn.textContent = 'All Posts';
		allBtn.addEventListener('click', () =>
		{
			this._activeYearFilter = null;
			this._activeMonthFilter = null;
			this._updateFilterBadge();
			this._renderYearsAndMonthsNav();
			this._applyFiltersAndReset();
		});
		this._archiveNavContainer.appendChild(allBtn);

		const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

		sortedYears.forEach(year =>
		{
			const yearGroup = document.createElement('div');
			yearGroup.className = 'archive-year-group';

			const yearPill = document.createElement('button');
			const isYearActive = this._activeYearFilter === year && this._activeMonthFilter === null;
			yearPill.className = `archive-pill year-pill ${isYearActive ? 'active' : ''}`;
			yearPill.textContent = String(year);
			yearPill.addEventListener('click', () =>
			{
				this._activeYearFilter = year;
				this._activeMonthFilter = null;
				this._updateFilterBadge();
				this._renderYearsAndMonthsNav();
				this._applyFiltersAndReset();
			});
			yearGroup.appendChild(yearPill);

			// Append months if this year is selected or active
			const months = Array.from(yearMonthMap.get(year)!).sort((a, b) => b - a);
			months.forEach(m =>
			{
				const monthPill = document.createElement('button');
				const isMonthActive = this._activeYearFilter === year && this._activeMonthFilter === m;
				monthPill.className = `archive-pill month-pill ${isMonthActive ? 'active' : ''}`;
				monthPill.textContent = monthNames[m - 1];
				monthPill.addEventListener('click', (e) =>
				{
					e.stopPropagation();
					this._activeYearFilter = year;
					this._activeMonthFilter = m;
					this._updateFilterBadge();
					this._renderYearsAndMonthsNav();
					this._applyFiltersAndReset();
				});
				yearGroup.appendChild(monthPill);
			});

			this._archiveNavContainer.appendChild(yearGroup);
		});
	}

	private _applyFiltersAndReset(): void
	{
		if(!this._data) return;

		let posts = [...this._data.posts];

		// 1. Tag Filter
		if(this._activeTagFilter)
		{
			posts = posts.filter(p =>
				(p.tags || []).some(t => t.toLowerCase() === this._activeTagFilter) ||
				(p.categories || []).some(c => c.toLowerCase() === this._activeTagFilter)
			);
		}

		// 2. Year Filter
		if(this._activeYearFilter !== null)
		{
			posts = posts.filter(p => new Date(p.date).getFullYear() === this._activeYearFilter);
		}

		// 3. Month Filter
		if(this._activeMonthFilter !== null)
		{
			posts = posts.filter(p => (new Date(p.date).getMonth() + 1) === this._activeMonthFilter);
		}

		// 4. Search Text Query
		if(this._searchQuery.trim())
		{
			const q = this._searchQuery.toLowerCase();
			posts = posts.filter(p =>
				p.title.toLowerCase().includes(q) ||
				p.summary.toLowerCase().includes(q) ||
				p.content_html.toLowerCase().includes(q)
			);
		}

		this._filteredPosts = posts;
		this._currentlyRenderedCount = 0;

		while(this._postsStreamContainer.firstChild)
		{
			this._postsStreamContainer.removeChild(this._postsStreamContainer.firstChild);
		}

		this._loadNextBatch();
	}

	private _updateFilterBadge(): void
	{
		const badge = this._filterBadge;
		const labels: string[] = [];

		if(this._activeTagFilter)
		{
			labels.push(`Tag: #${this._activeTagFilter}`);
		}
		if(this._activeYearFilter)
		{
			if(this._activeMonthFilter)
			{
				const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
				labels.push(`Date: ${monthNames[this._activeMonthFilter - 1]}${this._activeYearFilter}`);
			} else
			{
				labels.push(`Year: ${this._activeYearFilter}`);
			}
		}

		if(labels.length > 0)
		{
			badge.textContent = `Filtered by ${labels.join(' | ')} ✕ Clear`;
			badge.style.display = 'inline-block';
			badge.onclick = () =>
			{
				this._activeTagFilter = null;
				this._activeYearFilter = null;
				this._activeMonthFilter = null;
				this._updateFilterBadge();
				this._renderYearsAndMonthsNav();
				this._applyFiltersAndReset();
			};
		} else
		{
			badge.style.display = 'none';
		}
	}

	private _filterByTag(tag: string | null): void
	{
		this._activeTagFilter = tag;
		this._updateFilterBadge();
		this._applyFiltersAndReset();
	}

	private _loadNextBatch(): void
	{
		if(this._currentlyRenderedCount >= this._filteredPosts.length)
		{
			this._loadingSpinner.style.display = 'none';
			return;
		}

		const nextBatch = this._filteredPosts.slice(
			this._currentlyRenderedCount,
			this._currentlyRenderedCount + this._pageSize
		);

		nextBatch.forEach(post =>
		{
			const card = this._createPostElement(post);
			this._postsStreamContainer.appendChild(card);
		});

		this._currentlyRenderedCount += nextBatch.length;

		if(this._currentlyRenderedCount >= this._filteredPosts.length)
		{
			this._loadingSpinner.style.display = 'none';
		}
		else
		{
			this._loadingSpinner.style.display = 'block';
		}
	}

	private _createPostElement(post: IBlogPost): HTMLElement
	{
		const article = document.createElement('article');
		article.className = 'blog-post-card';

		const header = document.createElement('header');
		header.className = 'post-card-header';

		const titleNode = document.createElement('h2');
		titleNode.className = 'post-card-title';
		titleNode.textContent = post.title;

		const metaNode = document.createElement('div');
		metaNode.className = 'post-card-meta';
		const formattedDate = new Date(post.date).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'long',
			day: 'numeric'
		});
		metaNode.textContent = `By ${post.author} • ${formattedDate}`;

		header.appendChild(titleNode);
		header.appendChild(metaNode);

		const bodyNode = document.createElement('div');
		bodyNode.className = 'post-card-body';
		bodyNode.innerHTML = post.content_html;

		article.appendChild(header);
		article.appendChild(bodyNode);

		if(post.modern_insight_2026)
		{
			const insightNode = document.createElement('div');
			insightNode.className = 'post-card-insight-2026';

			const badge = document.createElement('span');
			badge.className = 'insight-badge';
			badge.textContent = 'TLDR';

			const text = document.createElement('p');
			text.textContent = post.modern_insight_2026;

			insightNode.appendChild(badge);
			insightNode.appendChild(text);
			article.appendChild(insightNode);
		}

		// Tag pills footer
		const footer = document.createElement('footer');
		footer.className = 'post-card-footer';

		(post.tags || []).forEach(tag =>
		{
			const pill = document.createElement('span');
			pill.className = 'tag-pill';
			pill.textContent = `#${tag}`;
			pill.addEventListener('click', () => this._filterByTag(tag.toLowerCase()));
			footer.appendChild(pill);
		});

		article.appendChild(footer);
		return article;
	}

	private _onScrollCheck(): void
	{
		const { scrollTop, scrollHeight, clientHeight } = this._scrollContainer;
		if(scrollTop + clientHeight >= scrollHeight - 150)
		{
			this._loadNextBatch();
		}
	}

	private _renderD3WordCloud(): void
	{
		if(!this._data || !this._data.tags.length) return;

		while(this._tagCloudContainer.firstChild)
		{
			this._tagCloudContainer.removeChild(this._tagCloudContainer.firstChild);
		}

		const width = this._tagCloudContainer.clientWidth || 600;
		const height = 140;

		const words = this._data.tags.map(t => ({
			text: t.text,
			size: t.size,
			count: t.count
		}));

		(d3 as any).layout.cloud()
			.size([width, height])
			.words(words)
			.padding(4)
			.rotate(() => (Math.random() > 0.8 ? 90 : 0))
			.font('system-ui')
			.fontSize((d: any) => d.size)
			.on('end', (renderedWords: {
				text: string | undefined;
				size: number | undefined;
				count: number;
			}[]) =>
			{
				const svg = d3
					.select(this._tagCloudContainer)
					.append('svg')
					.attr('width', width)
					.attr('height', height);

				const g = svg
					.append('g')
					.attr('transform', `translate(${width / 2},${height / 2})`);

				g.selectAll('text')
					.data(renderedWords)
					.enter()
					.append('text')
					.style('font-size', d => `${d.size}px`)
					.style('font-family', 'system-ui')
					.style('fill', () => d3.schemeTableau10[Math.floor(Math.random() * 10)])
					.attr('text-anchor', 'middle')
					.attr('transform', (d: any) => `translate(${d.x},${d.y}) rotate(${d.rotate})`)
					.text((d: any) => d.text)
					.attr('class', 'cloud-tag-item')
					.on('click', (_, d: any) => this._filterByTag(d.text.toLowerCase()));
			})
			.start();
	}
}
