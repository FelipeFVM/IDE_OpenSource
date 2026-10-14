/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRange } from '../../../../editor/common/core/range.js';
import { ITextModel } from '../../../../editor/common/model.js';

/**
 * Text to insert for a code block at `range`. A multi-line block is kept on
 * lines of its own so that it does not merge with the code before or after
 * the insertion point; single-line snippets are inserted unchanged.
 */
export function getCodeBlockInsertText(model: ITextModel, range: IRange, code: string): string {
	if (!code.includes('\n')) {
		return code;
	}
	const eol = model.getEOL();
	const before = model.getLineContent(range.startLineNumber).slice(0, range.startColumn - 1);
	const after = model.getLineContent(range.endLineNumber).slice(range.endColumn - 1);
	let text = code;
	if (before.trim()) {
		text = eol + text;
	}
	if (after.trim() && !text.endsWith('\n')) {
		text += eol;
	}
	return text;
}
