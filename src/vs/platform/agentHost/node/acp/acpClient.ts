/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isObject } from '../../../../base/common/types.js';

export function isAcpRecord(value: unknown): value is Record<string, unknown> { return isObject(value); }

/** ACP preserves JSON-RPC semantics across stdio and custom remote transports. */
export interface IAcpTransport extends IDisposable {
	readonly onMessage: Event<unknown>;
	readonly onClose: Event<Error>;
	send(message: object): void;
}

interface IPendingRequest {
	readonly resolve: (result: unknown) => void;
	readonly reject: (error: Error) => void;
	cancellation?: IDisposable;
	timer?: ReturnType<typeof setTimeout>;
}

export class AcpRpcError extends Error {
	constructor(readonly code: number, message: string) { super(message); }
}

export interface IAcpRequestOptions {
	/** Zero disables the deadline for long-running prompts. */
	readonly timeoutMs?: number;
	readonly token?: CancellationToken;
}

export interface IAcpNotification {
	readonly method: string;
	readonly params: unknown;
}

/** Connection-owned request correlation; providers own sessions, approvals and cancellation. */
export class AcpClient extends Disposable {
	private nextRequestId = 1;
	private readonly pending = new Map<number, IPendingRequest>();
	private readonly handlers = new Map<string, (params: unknown) => Promise<unknown>>();
	private readonly notificationEmitter = this._register(new Emitter<IAcpNotification>());
	readonly onNotification = this.notificationEmitter.event;
	private readonly closeEmitter = this._register(new Emitter<Error>());
	readonly onClose = this.closeEmitter.event;
	private closed: Error | undefined;

	constructor(private readonly transport: IAcpTransport) {
		super();
		this._register(transport);
		this._register(transport.onMessage(message => this.accept(message)));
		this._register(transport.onClose(error => this.close(error)));
	}

	request(method: string, params: unknown, options: IAcpRequestOptions = {}): Promise<unknown> {
		if (this.closed) { return Promise.reject(this.closed); }
		const token = options.token ?? CancellationToken.None;
		if (token.isCancellationRequested) { return Promise.reject(new CancellationError()); }
		const timeout = options.timeoutMs ?? 30_000;
		if (!Number.isFinite(timeout) || timeout < 0) { return Promise.reject(new RangeError('Invalid ACP request timeout')); }
		const id = this.nextRequestId++;
		return new Promise((resolve, reject) => {
			const pending: IPendingRequest = { resolve, reject };
			this.pending.set(id, pending);
			pending.cancellation = token.onCancellationRequested(() => this.finish(id, new CancellationError()));
			if (timeout > 0) {
				pending.timer = setTimeout(() => this.finish(id, new Error(`ACP request timed out: ${method}`)), timeout);
			}
			try { this.transport.send({ jsonrpc: '2.0', id, method, params }); } catch {
				this.close(new Error('ACP transport write failed'));
			}
		});
	}

	/** ACP turn cancellation is session/cancel; cancelling a local wait sends no invented RPC. */
	notify(method: string, params: unknown): void {
		if (this.closed) { throw this.closed; }
		try { this.transport.send({ jsonrpc: '2.0', method, params }); } catch {
			const error = new Error('ACP transport write failed');
			this.close(error);
			throw error;
		}
	}

	registerRequestHandler(method: string, handler: (params: unknown) => Promise<unknown>): IDisposable {
		if (this.handlers.has(method)) { throw new Error(`ACP request handler already registered: ${method}`); }
		this.handlers.set(method, handler);
		return toDisposable(() => { if (this.handlers.get(method) === handler) { this.handlers.delete(method); } });
	}

	private accept(message: unknown): void {
		if (this.closed) { return; }
		if (!isAcpRecord(message) || message.jsonrpc !== '2.0') {
			this.close(new Error('Invalid ACP JSON-RPC message'));
			return;
		}
		// Agent requests can use the same ids as our own requests. Route by
		// method first so a permission request never resolves a pending prompt.
		if (typeof message.method === 'string') {
			if (message.id === undefined) {
				this.notificationEmitter.fire({ method: message.method, params: message.params });
			} else if (typeof message.id === 'string' || typeof message.id === 'number' && Number.isFinite(message.id)) {
				void this.respond(message.id, message.method, message.params);
			} else {
				this.close(new Error('Invalid ACP request id'));
			}
			return;
		}
		if (typeof message.id !== 'number' || !Number.isFinite(message.id)) {
			this.close(new Error('Invalid ACP response id'));
			return;
		}
		if (!this.pending.has(message.id)) { return; } // Late response to a cancelled/timed-out request.
		const hasResult = Object.hasOwn(message, 'result');
		const hasError = Object.hasOwn(message, 'error');
		if (hasError === hasResult) {
			this.close(new Error('Invalid ACP response envelope'));
		} else if (hasError) {
			if (!isAcpRecord(message.error) || typeof message.error.code !== 'number' || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string') {
				this.close(new Error('Invalid ACP error response'));
			} else {
				this.finish(message.id, new AcpRpcError(message.error.code as number, message.error.message));
			}
		} else {
			this.finish(message.id, undefined, message.result);
		}
	}

	private async respond(id: string | number, method: string, params: unknown): Promise<void> {
		const handler = this.handlers.get(method);
		let response: object;
		if (!handler) {
			response = { error: { code: -32601, message: 'Unsupported ACP client method' } };
		} else {
			try { response = { result: await handler(params) }; } catch {
				response = { error: { code: -32603, message: 'ACP client request failed' } };
			}
		}
		if (this.closed) { return; }
		try { this.transport.send({ jsonrpc: '2.0', id, ...response }); } catch {
			this.close(new Error('ACP transport write failed'));
		}
	}

	private finish(id: number, error?: Error, result?: unknown): void {
		const pending = this.pending.get(id);
		if (!pending) { return; }
		this.pending.delete(id);
		clearTimeout(pending.timer);
		pending.cancellation?.dispose();
		if (error) { pending.reject(error); } else { pending.resolve(result); }
	}

	private close(error: Error): void {
		if (this.closed) { return; }
		this.closed = error;
		for (const id of this.pending.keys()) { this.finish(id, error); }
		this.closeEmitter.fire(error);
		this.transport.dispose();
	}

	override dispose(): void {
		this.close(new CancellationError());
		this.handlers.clear();
		super.dispose();
	}
}

/** Advertise only capabilities the host has implemented; providers negotiate the rest. */
export async function initializeAcp(client: AcpClient, clientInfo: { name: string; version: string }, token = CancellationToken.None): Promise<Record<string, unknown>> {
	const result = await client.request('initialize', {
		protocolVersion: 1, clientInfo,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
	}, { token });
	if (!isAcpRecord(result) || result.protocolVersion !== 1 || !isAcpRecord(result.agentCapabilities)) {
		throw new Error('The agent did not negotiate ACP version 1');
	}
	return result;
}
