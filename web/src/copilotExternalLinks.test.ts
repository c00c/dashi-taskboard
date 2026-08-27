import { afterEach, describe, expect, it, vi } from "vitest";
import { installCopilotExternalLinkHandler } from "./copilotExternalLinks";

const CURRENT_URL = "https://taskboard.example/projects/local?issue=TASK-42";

function appendBlankLink(href: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  const child = document.createElement("span");
  link.append(child);
  document.body.append(link);
  return link;
}

function click(link: HTMLAnchorElement): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  link.firstElementChild?.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Copilot external link handling", () => {
  it.each([
    ["same-origin HTTPS", "https://taskboard.example/projects/local?issue=TASK-43"],
    ["relative issue", "./?issue=TASK-43"],
    ["root-relative issue", "/projects/local?issue=TASK-43"],
    ["fragment", "#comment-12"],
    ["composer reference", "taskboard://composer-reference/v1/skill/bWFuYWdlLXRhc2tib2FyZA"],
    ["unsafe script scheme", "javascript:alert(1)"],
    ["non-HTTP external scheme", "mailto:maintainer@example.com"],
  ])("leaves %s links to existing web behavior", async (_category, href) => {
    const openExternalLink = vi.fn<() => Promise<void>>().mockResolvedValue();
    const existingWebHandler = vi.fn();
    const removeHandler = installCopilotExternalLinkHandler({
      currentUrl: CURRENT_URL,
      openExternalLink,
      onError: vi.fn(),
      onSuccess: vi.fn(),
    });
    const link = appendBlankLink(href);
    link.addEventListener("click", existingWebHandler);

    const event = click(link);
    await Promise.resolve();

    expect(event.defaultPrevented).toBe(false);
    expect(existingWebHandler).toHaveBeenCalledOnce();
    expect(openExternalLink).not.toHaveBeenCalled();
    removeHandler();
  });

  it("opens only cross-origin HTTP links and reports host success or failure", async () => {
    const hostError = new Error("Copilot host rejected the link");
    const openExternalLink = vi.fn<(url: string) => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(hostError);
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const removeHandler = installCopilotExternalLinkHandler({
      currentUrl: CURRENT_URL,
      openExternalLink,
      onError,
      onSuccess,
    });

    const successEvent = click(appendBlankLink("https://docs.example/review?id=42"));
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(successEvent.defaultPrevented).toBe(true);
    expect(openExternalLink).toHaveBeenNthCalledWith(1, "https://docs.example/review?id=42");
    expect(onError).not.toHaveBeenCalled();

    const failureEvent = click(appendBlankLink("http://reviews.example/failure"));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(hostError));
    expect(failureEvent.defaultPrevented).toBe(true);
    expect(openExternalLink).toHaveBeenNthCalledWith(2, "http://reviews.example/failure");
    expect(onSuccess).toHaveBeenCalledOnce();
    removeHandler();
  });
});
