import { Message } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import { GOOGLE_CLOUD_API_KEY, GoogleDriveWidget, PUBLIC_GOOGLE_DRIVE_FOLDER_ID } from '../filelist/widget-google';
import type { LuminoLayoutWindow } from '../bundle/lumino.d';
import type { GlobalToolbarsWindow } from '../bundle/menu.d';
import { DEFAULT_HTTP_INDEX_URL, HttpIndexWidget } from '../filelist/widget-index';
import type { DriveFile, WidgetErrorEventArgs } from '../filelist/widget.d';

const widgetSelf = self as unknown as LuminoLayoutWindow & GlobalToolbarsWindow & {
	HttpIndexWidget: typeof HttpIndexWidget;
	GoogleDriveWidget?: typeof GoogleDriveWidget;
	ArtWidget?: typeof ArtWidget;
};

export interface GoogleDriveClipartConfig
{
	apiKey: string;
	rootFolderId: string;
	rootFolderIndex: string;
	itemsPerPage?: number;
}

interface DriveFolderMeta
{
	id: string;
	rawName: string;
	category: string;
	style: string;
	isHttpSource?: boolean;
}

export class ArtWidget extends Widget
{
	private apiKey: string;
	private rootFolderId: string;
	private rootFolderIndex: string;
	private _googleWidget: GoogleDriveWidget | HttpIndexWidget | undefined;

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
		this.rootFolderIndex = config?.rootFolderIndex ?? DEFAULT_HTTP_INDEX_URL;
	}

	/**
	 * Spawns the GoogleDriveWidget as a sidebar panel inside the main DockPanel layout
	 */
	private _openGoogleSidebar(): void
	{
		if(!this._googleWidget && widgetSelf.GoogleDriveWidget)
		{
			this._googleWidget = new widgetSelf.GoogleDriveWidget('Generations', this.rootFolderId);
			this._googleWidget.errorOccurred.connect(this.handleWidgetError, this);
		}

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

	private handleWidgetError(sender: GoogleDriveWidget | HttpIndexWidget, args: WidgetErrorEventArgs): void
	{
		console.warn(`Widget ${sender.id} failed:`, args.error);

		this._googleWidget?.close();
		this._googleWidget = undefined;

		if(!this._googleWidget && widgetSelf.HttpIndexWidget)
		{
			this._googleWidget = new widgetSelf.HttpIndexWidget('Generations', this.rootFolderIndex);
			this._googleWidget.errorOccurred.connect(this.handleWidgetError, this);
		}

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
		let firstError: Error | undefined;

		try
		{
			const subfolders = await widgetSelf.GoogleDriveWidget?.fetchDriveFiles(
				`'${this.rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
			);

			const cleanFolders = subfolders?.filter(f => !f.name.startsWith('.') && !this.isForbidden(f.name));

			if(cleanFolders && cleanFolders.length > 0)
			{
				this.parseAndBuildCategoryMap(
					cleanFolders.map(f => ({ id: f.id, name: f.name })),
					false
				);
			}
		} catch(e)
		{
			if(e instanceof Error)
				firstError = e;
		}

		// Fallback to HTTP index server if Google Drive API fails or returns no categories
		if(firstError || Object.keys(this.categoryMap).length === 0)
		{
			try
			{
				const parts = this.rootFolderIndex.replace('://', '').split('/');
				const database = parts[0];
				const newChildren = await widgetSelf.HttpIndexWidget?.fetchHttpIndexFolderNodes?.(this.rootFolderIndex, '/', database);

				const cleanFolders = newChildren
					?.filter(f => !f.text.startsWith('.') && !f.path.startsWith('.') && !this.isForbidden(f.text))
					.filter(f => f.mode ? (f.mode >> 12) === 4 : false);

				if(cleanFolders && cleanFolders.length > 0)
				{
					this.parseAndBuildCategoryMap(
						cleanFolders.map(f => ({ id: f.id || f.path, name: f.text })),
						true
					);
				}
			}
			catch(fallbackErr)
			{
				console.error('Failed to load HTTP index fallback:', fallbackErr);
			}
		}

		if(Object.keys(this.categoryMap).length === 0)
		{
			this.node.innerHTML = `<div class="empty-state">No valid categories found in Google Drive or HTTP Server.</div>`;
			return;
		}

		this.renderWidgetFrame();
	}

	/**
	 * Parses folder names dynamically based on prefix frequency analysis across all available folders.
	 */
	private parseAndBuildCategoryMap(folders: { id: string; name: string; }[], isHttpSource: boolean): void
	{
		this.categoryMap = {};

		// Tokenize clean words for frequency scoring
		const folderTokenList = folders.map(f =>
		{
			const clean = f.name.trim();
			const tokens = clean.split(/[\s_\-]+/).filter(t => t.length > 0);
			return { folder: f, tokens, rawName: clean };
		});

		// 1. Build prefix frequency map for word lengths 1 to 3
		const prefixCounts: { [prefix: string]: number; } = {};

		folderTokenList.forEach(item =>
		{
			const t = item.tokens;
			if(t.length === 0) return;

			// Normalize first word, first two words, first three words
			for(let len = 1; len <= Math.min(3, t.length); len++)
			{
				const prefixKey = t.slice(0, len).join(' ').toLowerCase();
				prefixCounts[prefixKey] = (prefixCounts[prefixKey] || 0) + 1;
			}
		});

		// 2. Classify each folder into optimal Category and Style
		folderTokenList.forEach(item =>
		{
			const t = item.tokens;
			if(t.length === 0)
			{
				this.addCategoryMeta({
					id: item.folder.id,
					rawName: item.rawName,
					category: 'Other',
					style: 'General',
					isHttpSource
				});
				return;
			}

			let splitIndex = 1;

			// Determine if multi-word prefix (e.g., "5 Love Languages" or "7 Wonders") exists across folders
			if(t.length >= 3)
			{
				const threeWordPrefix = t.slice(0, 3).join(' ').toLowerCase();
				const twoWordPrefix = t.slice(0, 2).join(' ').toLowerCase();
				const oneWordPrefix = t[0].toLowerCase();

				// If 3-word prefix has higher/equal recurrence than downstream specific titles, use it
				if((prefixCounts[threeWordPrefix] || 0) > 1)
				{
					splitIndex = 3;
				}
				else if((prefixCounts[twoWordPrefix] || 0) > 1)
				{
					splitIndex = 2;
				}
				else if((prefixCounts[oneWordPrefix] || 0) > 1)
				{
					splitIndex = 1;
				}
				else if(/^\d+$/.test(t[0]))
				{
					// Number prefix fallback: include next 1-2 words if not recognized
					splitIndex = Math.min(t.length - 1 || 1, 3);
				}
			}
			else if(t.length === 2)
			{
				const twoWordPrefix = t.slice(0, 2).join(' ').toLowerCase();
				const oneWordPrefix = t[0].toLowerCase();

				if((prefixCounts[twoWordPrefix] || 0) > (prefixCounts[oneWordPrefix] || 0))
				{
					splitIndex = 2;
				}
				else if((prefixCounts[oneWordPrefix] || 0) > 1)
				{
					splitIndex = 1;
				}
				else
				{
					splitIndex = 1;
				}
			}

			const categoryTokens = t.slice(0, splitIndex);
			const styleTokens = t.slice(splitIndex);

			const rawCat = categoryTokens.join(' ');
			const category = rawCat.replace(/\b\w/g, c => c.toUpperCase());

			const rawStyle = styleTokens.join(' ');
			const style = rawStyle ? rawStyle.replace(/\b\w/g, c => c.toUpperCase()) : 'General';

			this.addCategoryMeta({
				id: item.folder.id,
				rawName: item.rawName,
				category,
				style,
				isHttpSource
			});
		});
	}

	private addCategoryMeta(meta: DriveFolderMeta): void
	{
		if(!this.categoryMap[meta.category])
		{
			this.categoryMap[meta.category] = {};
		}
		this.categoryMap[meta.category][meta.style] = meta;
	}

	/**
	 * Fetches high-res Google CDN or HTTP thumbnail binary via CORS fetch with no-referrer fallback
	 */
	private async getDriveImageBlobUrl(file: DriveFile): Promise<string>
	{
		if(this.blobUrlCache[file.id])
		{
			return this.blobUrlCache[file.id];
		}

		let rawUrl = file.thumbnailLink
			? file.thumbnailLink.replace(/=s\d+$/, '=s1200')
			: (file.webContentLink || `https://lh3.googleusercontent.com/d/${file.id}=s1200`);

		try
		{
			const response = await fetch(rawUrl, {
				method: 'GET',
				mode: 'cors',
				credentials: 'omit',
				referrerPolicy: 'no-referrer'
			});

			if(!response.ok) throw new Error(`HTTP ${response.status}`);

			const blob = await response.blob();
			const objectUrl = URL.createObjectURL(blob);
			this.blobUrlCache[file.id] = objectUrl;
			return objectUrl;
		}
		catch(err)
		{
			return rawUrl;
		}
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

		images.forEach(async (img, idx) =>
		{
			try
			{
				const imageUrl = await this.getDriveImageBlobUrl(img);
				const cardNode = this.node.querySelector(`#cf-card-${idx}`) as HTMLElement;
				if(cardNode)
				{
					cardNode.style.backgroundImage = `url("${imageUrl}")`;
					cardNode.style.backgroundSize = 'cover';
					cardNode.style.backgroundPosition = 'center';
				}
			}
			catch(err)
			{
				console.error(`Failed to load image for ${img.name}:`, err);
			}
		});
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

		const images = await this.loadFolderImagesLazy(folderMeta);
		this.activeImageIdx = 0;
		this.renderCoverflow(images);
	}

	/**
	 * Lazily fetches images for a selected style folder from either Google Drive or HTTP Index fallback
	 */
	private async loadFolderImagesLazy(meta: DriveFolderMeta): Promise<DriveFile[]>
	{
		const folderId = meta.id;
		if(this.imageCache[folderId])
		{
			return this.imageCache[folderId];
		}

		let cleanImages: DriveFile[] = [];

		if(meta.isHttpSource)
		{
			// Fetch child image nodes from HTTP index server fallback
			try
			{
				const parts = this.rootFolderIndex.replace('://', '').split('/');
				const database = parts[0];
				const folderPath = meta.id.startsWith('/') ? meta.id : `/${meta.rawName}`;

				const children = await widgetSelf.HttpIndexWidget?.fetchHttpIndexFolderNodes?.(this.rootFolderIndex + '/' + folderPath, folderPath, database);

				if(children)
				{
					cleanImages = children
						.filter(c => !c.text.startsWith('.') && !this.isForbidden(c.text))
						.filter(c => /\.(png|jpe?g|gif|webp|tga|pcx|bmp|dds)$/i.test(c.path))
						.map(c => ({
							id: c.id || c.path,
							name: c.text,
							mimeType: 'image/jpeg',
							thumbnailLink: `${this.rootFolderIndex.replace(/\/$/, '')}${c.path}`,
							webContentLink: `${this.rootFolderIndex.replace(/\/$/, '')}${c.path}`
						}));
				}
			}
			catch(err)
			{
				console.error(`Failed to load HTTP index images for folder ${folderId}:`, err);
			}
		}
		else if(widgetSelf.GoogleDriveWidget)
		{
			// Fetch child images via Google Drive API
			const query = `'${folderId}' in parents and (mimeType contains 'image/') and trashed = false`;
			const images = await widgetSelf.GoogleDriveWidget.fetchDriveFiles(query);
			cleanImages = images.filter(i => !i.name.startsWith('.') && !this.isForbidden(i.name));
		}

		this.imageCache[folderId] = cleanImages;
		return cleanImages;
	}

	private getActiveImages(): DriveFile[]
	{
		const folderMeta = this.categoryMap[this.activeCategory]?.[this.activeStyle];
		if(!folderMeta) return [];
		return this.imageCache[folderMeta.id] || [];
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
