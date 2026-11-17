/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IsSessionsWindowContext } from '../../../common/contextkeys.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';

/** A registered provider can manage customizations without a default editor chat participant. */
export const SessionsCustomizationsAvailableContext = new RawContextKey<boolean>('sessionsCustomizationsAvailable', false);
export const CustomizationsEnabledContext = ContextKeyExpr.or(
	ChatContextKeys.enabled,
	ContextKeyExpr.and(IsSessionsWindowContext, ChatContextKeys.Setup.hidden.negate(), SessionsCustomizationsAvailableContext),
)!;

export const OPEN_AI_CUSTOMIZATIONS_COMMAND_ID = 'sessions.customization.overview';

export interface IOpenAICustomizationsCommandOptions {
	readonly migration?: boolean;
}
