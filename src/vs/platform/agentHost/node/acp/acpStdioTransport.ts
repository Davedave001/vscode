/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChildProcessWithoutNullStreams } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IAcpTransport } from './acpClient.js';

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** Owns one child. Stderr is drained without echoing possible credential-bearing diagnostics. */
export class AcpStdioTransport extends Disposable implements IAcpTransport {
	private readonly messageEmitter = this._register(new Emitter<unknown>());
	readonly onMessage = this.messageEmitter.event;
	private readonly closeEmitter = this._register(new Emitter<Error>());
	readonly onClose = this.closeEmitter.event;
	private readonly decoder = new StringDecoder('utf8');
	private buffer = '';
	private closed = false;

	constructor(private readonly child: ChildProcessWithoutNullStreams) {
		super();
		const data = (chunk: Buffer) => this.accept(this.decoder.write(chunk));
		const end = () => {
			this.accept(this.decoder.end());
			this.fail(new Error(this.buffer.trim() ? 'ACP process ended with an incomplete message' : 'ACP process output ended'));
		};
		const exit = (code: number | null) => this.fail(new Error(`ACP process exited (${code ?? 'signal'})`));
		const error = () => this.fail(new Error('ACP process failed'));
		const stderr = () => { };
		child.stdout.on('data', data);
		child.stdout.on('end', end);
		child.stdout.on('error', error);
		child.stdin.on('error', error);
		child.stderr.on('data', stderr);
		child.on('error', error);
		child.on('exit', exit);
		this._register(toDisposable(() => {
			child.stdout.off('data', data);
			child.stdout.off('end', end);
			child.stdout.off('error', error);
			child.stdin.off('error', error);
			child.stderr.off('data', stderr);
			child.off('error', error);
			child.off('exit', exit);
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
			if (child.exitCode === null && child.signalCode === null) { child.kill(); }
		}));
	}

	send(message: object): void {
		if (this.closed) { throw new Error('ACP transport is closed'); }
		const line = JSON.stringify(message);
		if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) { throw new Error('ACP message exceeds the size limit'); }
		this.child.stdin.write(line + '\n');
	}

	private accept(chunk: string): void {
		if (this.closed) { return; }
		this.buffer += chunk;
		let newline: number;
		while ((newline = this.buffer.indexOf('\n')) !== -1) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (!line.trim()) { continue; }
			if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) { this.fail(new Error('ACP message exceeds the size limit')); return; }
			let message: unknown;
			try { message = JSON.parse(line); } catch { this.fail(new Error('Invalid ACP JSON message')); return; }
			this.messageEmitter.fire(message);
			if (this.closed) { return; }
		}
		if (Buffer.byteLength(this.buffer) > MAX_MESSAGE_BYTES) { this.fail(new Error('ACP message exceeds the size limit')); }
	}

	private fail(error: Error): void {
		if (this.closed) { return; }
		this.closed = true;
		this.closeEmitter.fire(error);
		this.dispose();
	}

	override dispose(): void {
		this.closed = true;
		this.buffer = '';
		super.dispose();
	}
}
