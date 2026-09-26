// @ts-check
/// <reference types="node" />

const serveIndex = require('serve-index');
const serveStatic = require('serve-static');
const fs = require('fs');
const path = require('path');
const { IncomingMessage, ServerResponse } = require('http');

// Set your removable storage path (e.g., /media/usb, /Volumes/ExternalDrive, or E:\)
const REMOVABLE_DRIVE_PATH = process.platform === 'win32'
	? 'D:\\'
	: '/mnt/T7';

// Subpath on the drive you want to index
const TARGET_DIR = path.join(REMOVABLE_DRIVE_PATH, 'stable-diffusion-webui', 'outputs', 'txt2img-images');

// Pre-configure the static and index middleware targeting the drive directory
const staticMiddleware = serveStatic(TARGET_DIR);
const indexMiddleware = serveIndex(TARGET_DIR, {
	icons: true,
	view: 'details',
	hidden: false
});

/**
 * Custom Dynamic Health-Checking Middleware
 * Validates drive availability per request before executing serve-index / serve-static
 *
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {Function} next
 * @returns {void | any}
 */
function removableStorageMiddleware(req, res, next)
{
	const originalUrl = req.url || '';

	// Only intercept requests starting with /clipart
	if(!originalUrl.startsWith('/clipart'))
	{
		return next();
	}

	// 1. Fix missing trailing slash on directory root (/clipart -> /clipart/)
	// serve-index will 404 or emit broken links if accessed without a trailing slash
	if(originalUrl === '/clipart')
	{
		res.statusCode = 301;
		res.setHeader('Location', '/clipart/');
		return res.end();
	}

	// Check if the drive/directory exists on every incoming request
	try
	{
		if(!fs.existsSync(TARGET_DIR))
		{
			res.statusCode = 503;
			res.setHeader('Content-Type', 'application/json');
			return res.end(JSON.stringify({
				error: 'Storage Unavailable',
				message: 'The removable storage device is currently disconnected or unmounted.',
				timestamp: new Date().toISOString()
			}));
		}

		// Validate read permissions/accessibility
		fs.accessSync(TARGET_DIR, fs.constants.R_OK);

	} catch(err)
	{
		if(err instanceof Error)
		{
			console.warn(`[Storage Warning] Drive access failed: ${err.message}`);
		}
		res.statusCode = 503;
		res.setHeader('Content-Type', 'application/json');
		return res.end(JSON.stringify({
			error: 'Storage I/O Error',
			message: 'Removable drive is attached but unreadable.',
			timestamp: new Date().toISOString()
		}));
	}

	// 2. STRIP THE ROUTE PREFIX
	// /clipart/subfolder/file.png -> /subfolder/file.png
	// /clipart/                  -> /
	const strippedUrl = originalUrl.replace(/^\/clipart\/*/, '') || '/';

	// Temporarily rewrite req.url for serve-static and serve-index
	req.url = strippedUrl;

	console.log(`[Storage] Serving ${originalUrl} -> ${path.join(TARGET_DIR, strippedUrl)}`);

	// Drive is connected and readable: pass through static first, then index
	staticMiddleware(req, res, () =>
	{
		indexMiddleware(req, res, (/** @type {any} */ err) =>
		{
			// Restore req.url in case subsequent downstream middlewares read it
			req.url = originalUrl;
			next(err);
		});
	});
}

module.exports = {
	removableStorageMiddleware
};
