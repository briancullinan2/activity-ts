import { Message } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import { GOOGLE_CLOUD_API_KEY, GoogleDriveWidget, PUBLIC_GOOGLE_DRIVE_FOLDER_ID } from '../filelist/widget-google';
import type { LuminoLayoutWindow } from '../bundle/lumino.d';
import type { GlobalToolbarsWindow } from '../bundle/menu.d';

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

interface DriveFolderMeta
{
	id: string;
	rawName: string;
	category: string;
	style: string;
}

export class ArtWidget extends Widget
{
	private apiKey: string;
	private rootFolderId: string;
	private _googleWidget: GoogleDriveWidget | undefined;

	// Parsed folder metadata map: category -> style -> folder metadata
	private categoryMap: { [category: string]: { [style: string]: DriveFolderMeta; }; } = {};
	// Lazy image cache indexed by folder ID
	private imageCache: { [folderId: string]: DriveFile[]; } = {};
	// Cache for local Blob URLs to fix COEP / CORS cross-origin image blocks
	private blobUrlCache: { [fileId: string]: string; } = {};

	private activeCategory: string = '';
	private activeStyle: string = '';
	private activeImageIdx: number = 0;

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
	 * Spawns the GoogleDriveWidget as a sidebar panel inside the main DockPanel layout
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
		this.node.innerHTML = `<div class="loading-state">Loading gallery structure...</div>`;
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
		// Clean up Object Blob URLs from memory on widget detachment
		Object.values(this.blobUrlCache).forEach(url => URL.revokeObjectURL(url));
		this.blobUrlCache = {};
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

	/**
	 * Single API call to fetch all category subfolders and parse them synchronously
	 */
	private async loadDriveGallery(): Promise<void>
	{
		const subfolders = await this.fetchDriveFiles(
			`'${this.rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
		);

		const cleanFolders = subfolders.filter(f => !f.name.startsWith('.') && !this.isForbidden(f.name));

		if(cleanFolders.length === 0)
		{
			this.node.innerHTML = `<div class="empty-state">No valid categories found in Google Drive folder.</div>`;
			return;
		}

		// Parse category and style synchronously from folder names
		this.categoryMap = {};

		cleanFolders.forEach(folder =>
		{
			const meta = this.parseFolderName(folder.id, folder.name);
			if(!this.categoryMap[meta.category])
			{
				this.categoryMap[meta.category] = {};
			}
			this.categoryMap[meta.category][meta.style] = meta;
		});

		this.renderWidgetFrame();
	}

	/**
	 * Splits folder names like "animals fauvism" -> Category: "Animals", Style: "Fauvism"
	 */
	private parseFolderName(id: string, rawName: string): DriveFolderMeta
	{
		const parts = rawName.trim().split(/\s+/);

		const rawCat = parts[0] || 'Other';
		const category = rawCat.charAt(0).toUpperCase() + rawCat.slice(1).toLowerCase();

		const rawStyle = parts.slice(1).join(' ');
		const style = rawStyle ? rawStyle.charAt(0).toUpperCase() + rawStyle.slice(1) : 'General';

		return { id, rawName, category, style };
	}

	private async fetchDriveFiles(query: string): Promise<DriveFile[]>
	{
		// Added thumbnailLink to requested fields
		const fields = 'files(id, name, mimeType, thumbnailLink, webContentLink, parents)';

		const params = new URLSearchParams({
			q: query,
			fields: fields,
			key: this.apiKey,
			pageSize: '1000',
			includeItemsFromAllDrives: 'true',
			supportsAllDrives: 'true'
		});

		const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;

		const response = await fetch(url, {
			method: 'GET',
			mode: 'cors',
			credentials: 'omit'
		});

		if(!response.ok)
		{
			const errJson = await response.json().catch(() => ({}));
			throw new Error(errJson.error?.message || `HTTP ${response.status}`);
		}

		const data = await response.json();
		return data.files || [];
	}

	/**
	 * Fetches high-res CDN thumbnail binary via CORS fetch and generates local Blob URL
	 */
	private async getDriveImageBlobUrl(file: DriveFile): Promise<string>
	{
		if(this.blobUrlCache[file.id])
		{
			return this.blobUrlCache[file.id];
		}

		// Fallback: If thumbnailLink is missing, use Google's direct public thumbnail URL format
		let rawThumbnail = file.thumbnailLink || `https://lh3.googleusercontent.com/d/${file.id}`;

		// Replace default size parameter (=s220) with high resolution (=s1200)
		const highResUrl = rawThumbnail.replace(/=s\d+$/, '=s1200');

		const response = await fetch(highResUrl, {
			method: 'GET',
			mode: 'cors',
			credentials: 'omit'
		});

		if(!response.ok) throw new Error(`HTTP ${response.status}`);

		const blob = await response.blob();
		const objectUrl = URL.createObjectURL(blob);
		this.blobUrlCache[file.id] = objectUrl;
		return objectUrl;
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

		const categories = Object.keys(this.categoryMap);
		if(categories.length > 0)
		{
			this.renderCategoryPills(categories);
			this.selectCategory(categories[0]);
		}
	}

	private renderCategoryPills(categories: string[]): void
	{
		const container = this.node.querySelector('#category-pills');
		if(!container) return;

		container.innerHTML = categories
			.map(
				cat => `
            <button class="art-pill ${cat === this.activeCategory ? 'active' : ''}" data-cat="${cat}">
                ${cat}
            </button>
        `
			)
			.join('');

		container.querySelectorAll('.art-pill').forEach(btn =>
		{
			btn.addEventListener('click', e =>
			{
				const cat = (e.currentTarget as HTMLElement).dataset.cat || '';
				this.selectCategory(cat);
			});
		});
	}

	private selectCategory(category: string): void
	{
		this.activeCategory = category;
		const categories = Object.keys(this.categoryMap);
		this.renderCategoryPills(categories);

		const stylesObj = this.categoryMap[category] || {};
		const styles = Object.keys(stylesObj);

		this.renderStyleTags(styles);
		if(styles.length > 0)
		{
			this.selectStyle(styles[0]);
		}
	}

	private renderStyleTags(styles: string[]): void
	{
		const container = this.node.querySelector('#style-tags');
		const section = this.node.querySelector('#styles-section') as HTMLElement;
		if(!container || !section) return;

		if(styles.length === 1 && styles[0] === 'General')
		{
			section.style.display = 'none';
			return;
		}

		section.style.display = 'block';
		container.innerHTML = styles
			.map(
				style => `
            <button class="art-style-tag ${style === this.activeStyle ? 'active' : ''}" data-style="${style}">
                ${style}
            </button>
        `
			)
			.join('');

		container.querySelectorAll('.art-style-tag').forEach(btn =>
		{
			btn.addEventListener('click', e =>
			{
				const style = (e.currentTarget as HTMLElement).dataset.style || '';
				this.selectStyle(style);
			});
		});
	}

	private async selectStyle(style: string): Promise<void>
	{
		this.activeStyle = style;
		const styles = Object.keys(this.categoryMap[this.activeCategory] || {});
		this.renderStyleTags(styles);

		const folderMeta = this.categoryMap[this.activeCategory]?.[style];
		if(!folderMeta) return;

		const stage = this.node.querySelector('#coverflow-container');
		if(stage)
		{
			stage.innerHTML = `<div class="loading-state">Loading images for ${style}...</div>`;
		}

		const images = await this.loadFolderImagesLazy(folderMeta.id);
		this.activeImageIdx = 0;
		this.renderCoverflow(images);
	}

	/**
	 * Lazily fetches images for a selected style folder with memory caching
	 */
	private async loadFolderImagesLazy(folderId: string): Promise<DriveFile[]>
	{
		if(this.imageCache[folderId])
		{
			return this.imageCache[folderId];
		}

		const query = `'${folderId}' in parents and (mimeType contains 'image/') and trashed = false`;
		const images = await this.fetchDriveFiles(query);
		const cleanImages = images.filter(i => !i.name.startsWith('.') && !this.isForbidden(i.name));

		this.imageCache[folderId] = cleanImages;
		return cleanImages;
	}

	private getActiveImages(): DriveFile[]
	{
		const folderMeta = this.categoryMap[this.activeCategory]?.[this.activeStyle];
		if(!folderMeta) return [];
		return this.imageCache[folderMeta.id] || [];
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
			.map((img, idx) => `
                <div class="coverflow-card" data-idx="${idx}" id="cf-card-${idx}">
                    <div class="coverflow-card-label">${img.name}</div>
                </div>
            `)
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

		// Fetch binary image blobs asynchronously using CDN thumbnails
		images.forEach(async (img, idx) =>
		{
			try
			{
				const blobUrl = await this.getDriveImageBlobUrl(img);
				const cardNode = this.node.querySelector(`#cf-card-${idx}`) as HTMLElement;
				if(cardNode)
				{
					cardNode.style.backgroundImage = `url('${blobUrl}')`;
				}
			}
			catch(err)
			{
				console.error(`Failed to load image blob for ${img.name}:`, err);
			}
		});
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
			const tokens = `${this.activeCategory} ${this.activeStyle} ${activeImg.name}`
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
