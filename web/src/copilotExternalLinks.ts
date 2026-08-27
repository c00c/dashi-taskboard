interface CopilotExternalLinkHandlerOptions {
  currentUrl: string;
  openExternalLink: (url: string) => Promise<void>;
  onError: (error: unknown) => void;
  onSuccess: () => void;
}

export function installCopilotExternalLinkHandler({
  currentUrl,
  openExternalLink,
  onError,
  onSuccess,
}: CopilotExternalLinkHandlerOptions): () => void {
  const currentOrigin = new URL(currentUrl).origin;

  function handleExternalLink(event: MouseEvent) {
    const link = event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>('a[target="_blank"]')
      : null;
    const rawHref = link?.getAttribute("href");
    if (!rawHref) return;

    let destination: URL;
    try {
      destination = new URL(rawHref, currentUrl);
    } catch {
      return;
    }
    if (
      (destination.protocol !== "http:" && destination.protocol !== "https:")
      || destination.origin === currentOrigin
    ) {
      return;
    }

    event.preventDefault();
    void openExternalLink(destination.href).then(onSuccess, onError);
  }

  document.addEventListener("click", handleExternalLink, true);
  return () => document.removeEventListener("click", handleExternalLink, true);
}
