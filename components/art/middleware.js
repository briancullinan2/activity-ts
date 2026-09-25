
// @ts-check
/// <reference types="node" />

import serveIndex from 'serve-index';
import serveStatic from 'serve-static';
import fs from 'fs';
import path from 'path';
import { IncomingMessage, ServerResponse } from 'http';

// Set your removable storage path (e.g., /media/usb, /Volumes/ExternalDrive, or E:\)
const REMOVABLE_DRIVE_PATH = process.platform === 'win32'
	? 'E:\\'
	: '/mnt/MyDrive';

// Subpath on the drive you want to index
const TARGET_DIR = path.join(REMOVABLE_DRIVE_PATH, 'public_files');

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
 */
/**
 *
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {Function} next
 * @returns {void | any}
 */
export function removableStorageMiddleware(req, res, next)
{
	const url = req.url || '';

	if(!url.startsWith(path.join('/clipart')))
	{
		return;
	}

	// Check if the drive/directory exists on every incoming request
	try
	{
		if(!fs.existsSync(TARGET_DIR))
		{
			res.statusCode = 500;
			return res.end(JSON.stringify({
				error: 'Storage Unavailable',
				message: 'The removable storage device is currently disconnected or unmounted.',
				timestamp: new Date().toISOString()
			}));
		}

		// Optional: Validate read permissions/accessibility
		fs.accessSync(TARGET_DIR, fs.constants.R_OK);

	} catch(err)
	{
		// Fails properly if the drive is unmounted, offline, or experiencing I/O errors
		if(err instanceof Error)
		{
			console.warn(`[Storage Warning] Drive access failed: ${err.message}`);
		}
		res.statusCode = 500;
		return res.end(JSON.stringify({
			error: 'Storage I/O Error',
			message: 'Removable drive is attached but unreadable.',
			timestamp: new Date().toISOString()
		}));
	}

	// Drive is connected and readable: pass through to serve-static first, then serve-index
	staticMiddleware(req, res, () =>
	{
		indexMiddleware(req, res, next);
	});
}
