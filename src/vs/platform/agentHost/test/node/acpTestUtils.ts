/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IAcpTransport } from '../../node/acp/acpClient.js';

export class TestAcpTransport extends Disposable implements IAcpTransport {
	private readonly messages = this._register(new Emitter<unknown>());
	readonly onMessage = this.messages.event;
	private readonly closes = this._register(new Emitter<Error>());
	readonly onClose = this.closes.event;
	private readonly sends = this._register(new Emitter<Record<string, unknown>>());
	readonly onSend = this.sends.event;
	readonly sent: Record<string, unknown>[] = [];
	handle: ((message: Record<string, unknown>) => void) | undefined;
	send(message: object): void { const value = message as Record<string, unknown>; this.sent.push(value); this.sends.fire(value); this.handle?.(value); }
	receive(message: unknown): void { this.messages.fire(message); }
	reply(request: Record<string, unknown>, result: unknown): void { this.receive({ jsonrpc: '2.0', id: request.id, result }); }
	close(): void { this.closes.fire(new Error('peer exited')); }
}
