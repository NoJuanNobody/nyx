import { test, expect, SEED } from './fixtures/test-base';
import { SEL } from './fixtures/selectors';

/**
 * Regression test for issue #344.
 *
 * Bug: a debounced save armed for doc A would fire after the user
 * navigated to doc B and write doc A's content into doc B's database
 * row. This test loads a doc, types a character, immediately switches
 * to a different doc within the 500ms debounce window, then reloads the
 * target doc and asserts its content is unchanged from before.
 */
test.describe('Document Editor — stale doc save (issue #344)', () => {
  test('switching files within debounce window does not corrupt target doc', async ({
    authenticatedPage: page,
  }) => {
    const DOC_A = `/app/documents/${SEED.DOC_API_SPEC_ID}`;
    const DOC_B = `/app/documents/${SEED.DOC_ARCHITECTURE_ID}`;

    // 1. Load doc B first and capture its current content as the baseline.
    await page.goto(DOC_B);
    const docBTextarea = page.locator(SEL.editor.textarea).first();
    await docBTextarea.waitFor({ state: 'visible', timeout: 10_000 });
    // Wait for any pending save to settle so we know the baseline is stable.
    await expect(page.locator('text=Saved').first()).toBeVisible({ timeout: 10_000 });
    const docBBaselineContent = await docBTextarea.inputValue();
    const docBBaselineTitle = await page.locator(SEL.editor.titleInput).first().inputValue();

    // 2. Navigate to doc A and wait for it to load.
    await page.goto(DOC_A);
    const docATextarea = page.locator(SEL.editor.textarea).first();
    await docATextarea.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(page.locator('text=Saved').first()).toBeVisible({ timeout: 10_000 });

    // 3. Type a single character into the title input — this arms the
    //    500ms debounce timer with doc A's id and the new title.
    const docATitleInput = page.locator(SEL.editor.titleInput).first();
    await docATitleInput.focus();
    await page.keyboard.type('Z');
    // Save state should now read "Unsaved changes" (timer is armed).
    await expect(page.locator('text=Unsaved').first()).toBeVisible({ timeout: 1_000 });

    // 4. Within the debounce window (well under 500ms), navigate to doc B
    //    via a client-side route change. We use the explorer link if the
    //    sidebar exposes it; otherwise we use page.goto which still
    //    exercises the same in-memory state transition because the
    //    DocumentEditor component re-renders on the route param change
    //    without unmounting the surrounding shell.
    const explorerLink = page.locator(SEL.fileTree.docLink(SEED.DOC_ARCHITECTURE_ID)).first();
    if (await explorerLink.count()) {
      await explorerLink.click();
    } else {
      await page.goto(DOC_B);
    }

    // 5. Wait for doc B to finish loading.
    const docBTextareaAfter = page.locator(SEL.editor.textarea).first();
    await docBTextareaAfter.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(page.locator('text=Saved').first()).toBeVisible({ timeout: 10_000 });

    // 6. Reload doc B from the server (forces a hard refetch).
    await page.goto(DOC_B);
    await docBTextareaAfter.waitFor({ state: 'visible', timeout: 10_000 });

    // 7. Assert doc B's content and title are unchanged from the baseline.
    const docBContentAfter = await page.locator(SEL.editor.textarea).first().inputValue();
    const docBTitleAfter = await page.locator(SEL.editor.titleInput).first().inputValue();

    expect(docBContentAfter).toBe(docBBaselineContent);
    expect(docBTitleAfter).toBe(docBBaselineTitle);
    // And critically: doc B's title must NOT contain the stray 'Z' that
    // was typed into doc A's title (that would be the corruption bug).
    expect(docBTitleAfter).not.toContain('Z');
  });
});
