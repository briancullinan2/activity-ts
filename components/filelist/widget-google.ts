import type { NestedTreeNode } from "../bundle/github-tools";
import { FileListWidget } from "./widget";
import Tree from './tree.js';
import type { GlobalToolbarsWindow } from "../bundle/menu.d";
import type { GithubWindow } from "../bundle/github.d";
import type { BuildWindow } from "../bundle/make.d";

const filelistSelf: GlobalToolbarsWindow & GithubWindow & BuildWindow & { driveApiKey?: string; GoogleDriveWidget: typeof GoogleDriveWidget; } = self as unknown as any;

export class GoogleDriveWidget extends FileListWidget
{

	/**
	 * Safe HTML Structure Injection
	 */
	protected override async renderLayout(): Promise<void>
	{
		if(this.node.innerHTML !== '')
		{
			return;
		}
		this.node.innerHTML = `
			<div class="filelist-wrapper">
				<ul class="toolbar">
					<li><a alt="New file" href="#new-file" class="bx bx-file-plus"></a></li>
					<li><a alt="New folder" href="#new-folder" class="bx bx-folder-plus"></a></li>
					<li><a alt="Google Drive" href="#new-gdrive" class="bx bxl bx-google-cloud"></a></li>
					<li><a alt="Hidden Files" href="#hidden" class="bx bx-eye-slash"></a></li>
					<li><a alt="Github Link" href="#link" class="bx bx-link"></a></li>
					<li><a alt="Refresh List" href="#refresh" class="bx bx-refresh-cw"></a></li>
					<li class="setting" data-placeholder="Owner">
						<select name="owner" class="filelist-owner">
						</select>
					</li>
					<li class="setting" data-placeholder="Repository">
						<select name="repository" class="filelist-repository">
						</select>
					</li>
					<li class="setting" data-placeholder="Branch">
						<select name="branch" class="filelist-branch">
						</select>
					</li>
				</ul>
				<div class="search-box">
				<input type="text" id="search" name="search" placeholder="Search many..." />
				</div>
				<div id="${this.treeContainerId}" class="treejs-render-target"></div>
			</div>
			`;

		const parts = this.defaultRepository.split('/');
		const ownerName = parts.length === 2 ? parts[0] : filelistSelf.RepositoryToolbar?.owner?.value;
		const repoName = parts.length === 2 ? parts[1] : parts[0] || filelistSelf.RepositoryToolbar?.repository?.value;

		const owner = (this.node.querySelector('.filelist-owner') as HTMLSelectElement);
		const owners = filelistSelf.settingsManager?.get('github', 'ownersList');
		filelistSelf.addOwnerIfNotExists?.(ownerName);
		filelistSelf.updateSelectOptions?.(owner, owners, ownerName);

		const repo = (this.node.querySelector('.filelist-repository') as HTMLSelectElement);
		const repositories = filelistSelf.settingsManager?.get('github', 'repositoriesList');
		filelistSelf.addRepoIfNotExists?.(repoName);
		filelistSelf.updateSelectOptions?.(repo, repositories, repoName);

		const branch = (this.node.querySelector('.filelist-branch') as HTMLSelectElement);
		const branches = await filelistSelf.getBranches?.(ownerName, repoName);
		if(branches)
		{
			filelistSelf.updateSelectOptions?.(branch, branches, branches[0].name);
		}
	}

	protected override async initializeFiletrees(): Promise<void>
	{
		await this.showGitRoot();
		this.bindMutationObserver();
	}

	public override get defaultRepository()
	{
		return this._source ?? 'GoogleDrive/Root';
	}

	private isForbidden(name: string): boolean
	{
		const lower = name.toLowerCase();
		return lower.includes('urpm') || lower.includes('naked') || lower.includes('x-rated') || lower.includes('nsfw');
	}

	/**
	 * Lazily load Google Drive subfolders & image files into virtual filesystem
	 */
	protected override async expandDatabaseTree(target: HTMLElement, folderId: string): Promise<void>
	{
		if(this.treeLoading) return;
		if(folderId.endsWith('[Recursive]')) return;

		const activeTree = filelistSelf.trees?.[this.selector];
		if(!activeTree || !activeTree.nodesById[folderId]) return;

		const apiKey = filelistSelf.driveApiKey || '';
		const parts = folderId.split('/');
		const database = `${parts[0]}/${parts[1]}`;
		const parentDriveId = parts[parts.length - 1]; // Assume ID is stored at leaf of folder ID key

		try
		{
			this.treeLoading = true;

			// Fetch children directly from Google Drive API
			const q = encodeURIComponent(`'${parentDriveId}' in parents and trashed = false`);
			const fields = encodeURIComponent('files(id, name, mimeType, size)');
			const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&key=${apiKey}&pageSize=1000`;

			const response = await fetch(url);
			if(!response.ok)
			{
				throw new Error(`Drive HTTP error! status: ${response.status}`);
			}

			const data = await response.json();
			const driveFiles: Array<{ id: string; name: string; mimeType: string; }> = data.files || [];

			if(filelistSelf.filesRepo && !filelistSelf.filesRepo[database])
			{
				filelistSelf.filesRepo[database] = {};
			}

			const newChildren: NestedTreeNode[] = [];

			for(const file of driveFiles)
			{
				// Apply NSFW and hidden-file filtering
				if(file.name.startsWith('.') || this.isForbidden(file.name)) continue;

				const isDir = file.mimeType === 'application/vnd.google-apps.folder';
				const nodePath = `${folderId}/${file.name}`;
				const nodeId = `${folderId}/${file.id}`;

				const newNode: NestedTreeNode = {
					id: nodeId,
					text: file.name,
					path: nodePath,
					parent: activeTree.nodesById[folderId],
					status: 0,
					state: { open: false, expanded: false },
					children: isDir
						? [{ text: 'Loading...', id: `${nodeId}/loading`, path: `${nodePath}/loading`, status: 0, state: { open: false, expanded: false } } as NestedTreeNode]
						: null
				};

				// Register inside local virtual filesystem mocks
				if(filelistSelf.filesRepo?.[database] && filelistSelf.FS)
				{
					filelistSelf.filesRepo[database][nodePath] = filelistSelf.FS.virtual[nodePath] = Object.assign(newNode, {
						mode: isDir ? (filelistSelf.ST_DIR ?? 0o040000) : (filelistSelf.FS_FILE ?? (0o100000 | 0o666)),
						driveId: file.id
					});
				}

				this.loadedDatabases[newNode.id] = activeTree.nodesById[newNode.id] = newNode;
				newChildren.push(newNode);
			}

			if(newChildren.length === 0)
			{
				newChildren.push({
					text: 'Empty...',
					id: `${folderId}/empty`,
					path: `${folderId}/empty`,
					status: 0,
					state: { open: false, expanded: false }
				});
			}

			filelistSelf.sortNodes?.(newChildren);
			this.loadedDatabases[folderId].children = activeTree.nodesById[folderId].children = newChildren;

		} catch(err: any)
		{
			console.error(`Failed to load Drive tree node: ${err.message}`);
			this.loadedDatabases[folderId] = {
				text: 'Error loading drive files',
				id: 'err',
				path: 'err',
				status: 0,
				state: { open: false, expanded: false }
			} as NestedTreeNode;
		}

		await this.showGitRoot(folderId);

		if(this.refreshTreeTimer) clearTimeout(this.refreshTreeTimer);

		this.refreshTreeTimer = setTimeout(async () =>
		{
			activeTree.values = [];
			const node = activeTree.nodesById[folderId];
			if(node) activeTree.open(node);
			setTimeout(() => { this.treeLoading = false; }, 300);
		}, 200);
	}

	private async showGitRoot(folderId?: string): Promise<void>
	{
		const database = this.defaultRepository;

		if(!this.loadedDatabases[database])
		{
			this.loadedDatabases[database] = {
				id: database,
				text: database,
				status: 0,
				state: { open: false, expanded: false },
				path: database,
				children: []
			};
		}

		const activeTree = filelistSelf.trees?.[this.selector];
		if(!activeTree && filelistSelf.trees)
		{
			filelistSelf.trees[this.selector] = filelistSelf.trees[database] = new Tree(this.selector, {
				data: this.loadedDatabases[database].children,
				autoOpen: false,
				closeDepth: null
			});
		} else if(folderId && activeTree)
		{
			activeTree.options.data = this.loadedDatabases[database].children;
			activeTree.renderPartial(folderId);
		}
	}
}

filelistSelf.GoogleDriveWidget = GoogleDriveWidget;
