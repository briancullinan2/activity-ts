import { Message } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import { GoogleDriveWidget } from '../filelist/widget-google';
import type { LuminoLayoutWindow } from '../bundle/lumino.d';
import type { GlobalToolbarsWindow } from '../bundle/menu.d';

const GOOGLE_CLOUD_API_KEY = 'AIzaSyAsZR_uPzhdnkNktP8CGKbooWndEUYaq9I';
const PUBLIC_GOOGLE_DRIVE_FOLDER_ID = '1iZXcde4zeQmFJoCedo70wu0ouZ1QF0Se'; // Clean Folder ID

const widgetSelf = self as unknown as LuminoLayoutWindow & GlobalToolbarsWindow & {
	GoogleDriveWidget?: typeof GoogleDriveWidget;
	ArtWidget?: typeof ArtWidget;
};

export interface GoogleDriveClipartConfig
{
	apiKey: string;
	rootFolderId: string;
	itemsPerPage?: number;
}

interface DriveFile
{
	id: string;
	name: string;
	mimeType: string;
	thumbnailLink?: string;
	webContentLink?: string;
}

interface CategoryStructure
{
	id: string;
	name: string;
	substyles: { [styleName: string]: DriveFile[]; };
}

export class ArtWidget extends Widget
{
	private apiKey: string;
	private rootFolderId: string;
	private categories: CategoryStructure[] = [];
	private activeCategoryIdx: number = 0;
	private activeStyleName: string | null = null;
	private activeImageIdx: number = 0;
	private _googleWidget: GoogleDriveWidget | undefined;

	constructor(title?: string, config?: GoogleDriveClipartConfig)
	{
		super();
		this.addClass('clipart-drive-widget');
		this.title.label = title ?? 'Drive Clip Art';
		this.title.closable = true;

		this.apiKey = config?.apiKey ?? GOOGLE_CLOUD_API_KEY;

		// Strip URL structures if full share URL is provided
		let rawId = config?.rootFolderId ?? PUBLIC_GOOGLE_DRIVE_FOLDER_ID;
		if(rawId.includes('/folders/'))
		{
			rawId = rawId.split('/folders/')[1].split('?')[0];
		}
		this.rootFolderId = rawId;
	}

	/**
	 * Spawns the ExhaustiveSkillsWidget as a sidebar panel inside the main DockPanel layout
	 */
	private _openGoogleSidebar(): void
	{
		this._googleWidget ??= widgetSelf.GoogleDriveWidget
			? new widgetSelf.GoogleDriveWidget('Generations', this.rootFolderId)
			: undefined;
		if(!widgetSelf.mainDock || !this._googleWidget)
		{
			return;
		}
		// Check if layout adjuster and main dock panel exist globally

		if(!this._googleWidget.isAttached)
		{
			widgetSelf.LayoutAdjuster?.addOptimalWidgetLayout(widgetSelf.mainDock, this._googleWidget, {
				type: 'outline',
				projectId: this._googleWidget.constructor.name
			});
		} else
		{
			this._googleWidget.show();
		}
	}

	protected override onAfterAttach(msg: Message): void
	{
		super.onAfterAttach(msg);
		this.node.innerHTML = `<div class="loading-state">Loading gallery from Google Drive...</div>`;
		this.loadDriveGallery().catch(err =>
		{
			console.error('Error loading Google Drive gallery:', err);
			this.node.innerHTML = `<div class="error-state">Failed to load clipart: ${err.message}</div>`;
		});
		this._openGoogleSidebar();

	}

	protected onActivateRequest(msg: Message): void
	{
		super.onActivateRequest(msg);
		this._openGoogleSidebar();
	}

	protected onAfterShow(msg: Message): void
	{
		super.onAfterShow(msg);
		this._openGoogleSidebar();
	}

	protected override onBeforeDetach(msg: Message): void
	{
		this._googleWidget?.close();
		super.onBeforeDetach(msg);
	}

	protected onBeforeHide(msg: Message): void
	{
		this._googleWidget?.close();
		super.onBeforeHide(msg);
	}

	private isForbidden(name: string): boolean
	{
		const lower = name.toLowerCase();
		return lower.includes('urpm') || lower.includes('naked') || lower.includes('x-rated') || lower.includes('nsfw');
	}

	private async loadDriveGallery(): Promise<void>
	{
		// Fetch subdirectories (Top-Level Categories) inside the root folder
		const subfolders = await this.fetchDriveFiles(
			`'${this.rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
		);

		const filteredCategories = subfolders.filter(f => !f.name.startsWith('.') && !this.isForbidden(f.name));

		if(filteredCategories.length === 0)
		{
			this.node.innerHTML = `<div class="empty-state">No valid categories found in Google Drive folder.</div>`;
			return;
		}

		// Build 2-tier tree: Category -> Files (or Sub-style Folders)
		this.categories = await Promise.all(
			filteredCategories.map(async catFolder =>
			{
				const childItems = await this.fetchDriveFiles(`'${catFolder.id}' in parents and trashed = false`);
				const substyles: { [styleName: string]: DriveFile[]; } = {};

				const directImages = childItems.filter(
					item => item.mimeType.startsWith('image/') && !item.name.startsWith('.') && !this.isForbidden(item.name)
				);

				if(directImages.length > 0)
				{
					substyles['General'] = directImages;
				}

				// Parse nested folders as distinct style presets
				const subFolders = childItems.filter(
					item => item.mimeType === 'application/vnd.google-apps.folder' && !item.name.startsWith('.') && !this.isForbidden(item.name)
				);

				await Promise.all(
					subFolders.map(async subF =>
					{
						const styleImgs = await this.fetchDriveFiles(
							`'${subF.id}' in parents and (mimeType contains 'image/') and trashed = false`
						);
						const cleanImgs = styleImgs.filter(i => !i.name.startsWith('.') && !this.isForbidden(i.name));
						if(cleanImgs.length > 0)
						{
							substyles[subF.name] = cleanImgs;
						}
					})
				);

				return { id: catFolder.id, name: catFolder.name, substyles };
			})
		);

		this.renderWidgetFrame();
	}

	private async fetchDriveFiles(query: string): Promise<DriveFile[]>
	{
		const fields = encodeURIComponent('files(id, name, mimeType, thumbnailLink, webContentLink)');
		const q = encodeURIComponent(query);
		const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&key=${this.apiKey}&pageSize=1000`;

		const response = await fetch(url);
		if(!response.ok)
		{
			const errJson = await response.json().catch(() => ({}));
			throw new Error(errJson.error?.message || `HTTP ${response.status}`);
		}

		const data = await response.json();
		return data.files || [];
	}

	private renderWidgetFrame(): void
	{
		this.node.innerHTML = `
            <div class="art-nav-section">
                <h2 class="art-nav-title">Clip Art</h2>
                <div class="art-pill-grid" id="category-pills"></div>
            </div>

            <div class="art-nav-section" id="styles-section">
                <h3 class="art-nav-title" style="font-size: 1.1rem;">Styles & Presets</h3>
                <div class="art-style-grid" id="style-tags"></div>
            </div>

            <div class="coverflow-stage">
                <button class="coverflow-btn prev" id="cf-prev">&#10094;</button>
                <div class="coverflow-container" id="coverflow-container"></div>
                <button class="coverflow-btn next" id="cf-next">&#10095;</button>
            </div>

            <div class="art-tags-container" id="dynamic-tags"></div>
        `;

		this.node.querySelector('#cf-prev')?.addEventListener('click', () => this.rotateCoverflow(-1));
		this.node.querySelector('#cf-next')?.addEventListener('click', () => this.rotateCoverflow(1));

		this.renderCategoryPills();
		this.selectCategory(0);
	}

	private renderCategoryPills(): void
	{
		const container = this.node.querySelector('#category-pills');
		if(!container) return;

		container.innerHTML = this.categories
			.map(
				(cat, idx) => `
            <button class="art-pill ${idx === this.activeCategoryIdx ? 'active' : ''}" data-idx="${idx}">
                ${cat.name}
            </button>
        `
			)
			.join('');

		container.querySelectorAll('.art-pill').forEach(btn =>
		{
			btn.addEventListener('click', e =>
			{
				const idx = parseInt((e.currentTarget as HTMLElement).dataset.idx || '0', 10);
				this.selectCategory(idx);
			});
		});
	}

	private selectCategory(idx: number): void
	{
		this.activeCategoryIdx = idx;
		this.renderCategoryPills();

		const category = this.categories[idx];
		const styleNames = Object.keys(category.substyles);
		this.activeStyleName = styleNames.length > 0 ? styleNames[0] : null;

		this.renderStyleTags(styleNames);
		this.updateCarouselImages();
	}

	private renderStyleTags(styleNames: string[]): void
	{
		const container = this.node.querySelector('#style-tags');
		const section = this.node.querySelector('#styles-section') as HTMLElement;
		if(!container || !section) return;

		if(styleNames.length <= 1 && styleNames[0] === 'General')
		{
			section.style.display = 'none';
			return;
		}

		section.style.display = 'block';
		container.innerHTML = styleNames
			.map(
				style => `
            <button class="art-style-tag ${style === this.activeStyleName ? 'active' : ''}" data-style="${style}">
                ${style}
            </button>
        `
			)
			.join('');

		container.querySelectorAll('.art-style-tag').forEach(btn =>
		{
			btn.addEventListener('click', e =>
			{
				this.activeStyleName = (e.currentTarget as HTMLElement).dataset.style || null;
				this.renderStyleTags(styleNames);
				this.updateCarouselImages();
			});
		});
	}

	private getActiveImages(): DriveFile[]
	{
		if(!this.categories[this.activeCategoryIdx] || !this.activeStyleName) return [];
		return this.categories[this.activeCategoryIdx].substyles[this.activeStyleName] || [];
	}

	private updateCarouselImages(): void
	{
		const images = this.getActiveImages();
		this.activeImageIdx = 0;
		this.renderCoverflow(images);
	}

	private renderCoverflow(images: DriveFile[]): void
	{
		const container = this.node.querySelector('#coverflow-container');
		if(!container) return;

		if(images.length === 0)
		{
			container.innerHTML = `<div class="empty-state">No images in selected style</div>`;
			this.updateTags([]);
			return;
		}

		container.innerHTML = images
			.map((img, idx) =>
			{
				const src = `https://www.googleapis.com/drive/v3/files/${img.id}?alt=media&key=${this.apiKey}`;
				return `
                <div class="coverflow-card" data-idx="${idx}" style="background-image: url('${src}');">
                    <div class="coverflow-card-label">${img.name}</div>
                </div>
            `;
			})
			.join('');

		container.querySelectorAll('.coverflow-card').forEach(card =>
		{
			card.addEventListener('click', e =>
			{
				const idx = parseInt((e.currentTarget as HTMLElement).dataset.idx || '0', 10);
				this.activeImageIdx = idx;
				this.applyCoverflowTransforms();
			});
		});

		this.applyCoverflowTransforms();
	}

	private rotateCoverflow(direction: number): void
	{
		const images = this.getActiveImages();
		if(images.length === 0) return;

		this.activeImageIdx = (this.activeImageIdx + direction + images.length) % images.length;
		this.applyCoverflowTransforms();
	}

	private applyCoverflowTransforms(): void
	{
		const cards = this.node.querySelectorAll('.coverflow-card');
		const total = cards.length;

		cards.forEach((card, idx) =>
		{
			card.className = 'coverflow-card';
			const offset = idx - this.activeImageIdx;

			if(offset === 0)
			{
				card.classList.add('active');
			} else if(offset === -1)
			{
				card.classList.add('left-1');
			} else if(offset === 1)
			{
				card.classList.add('right-1');
			} else if(offset === -2)
			{
				card.classList.add('left-2');
			} else if(offset === 2)
			{
				card.classList.add('right-2');
			} else
			{
				card.classList.add('hidden');
			}
		});

		const activeImg = this.getActiveImages()[this.activeImageIdx];
		if(activeImg)
		{
			const tokens = `${this.categories[this.activeCategoryIdx].name} ${this.activeStyleName || ''} ${activeImg.name}`
				.toLowerCase()
				.split(/[^a-z0-9]/gi)
				.filter((v, i, a) => v.length > 2 && a.indexOf(v) === i);
			this.updateTags(tokens);
		}
	}

	private updateTags(tokens: string[]): void
	{
		const container = this.node.querySelector('#dynamic-tags');
		if(!container) return;

		container.innerHTML = tokens.map(t => `<span class="art-tag-chip">#${t}</span>`).join('');
	}
}

widgetSelf.ArtWidget = ArtWidget;
