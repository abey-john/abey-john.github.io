export interface ImageModalData {
  url: string;
  name: string;
  tag?: string;
  tagClass?: string;
  blurb?: string;
}

let previousFocusedElement: HTMLElement | null = null;

export function isImageModalOpen(): boolean {
  const modalEl = document.getElementById('travel-image-modal');
  return Boolean(modalEl && modalEl.classList.contains('is-open'));
}

export function openImageModal(data: ImageModalData): void {
  const modalEl = document.getElementById('travel-image-modal');
  if (!modalEl) return;

  const pictureSource = document.getElementById('travel-modal-source') as HTMLSourceElement | null;
  const imgEl = document.getElementById('travel-modal-img') as HTMLImageElement | null;
  const tagEl = document.getElementById('travel-modal-tag');
  const titleEl = document.getElementById('travel-modal-title');
  const blurbEl = document.getElementById('travel-modal-blurb');
  const closeBtn = document.getElementById('travel-modal-close-btn') as HTMLButtonElement | null;

  if (imgEl) {
    const webpUrl = data.url.replace(/\.(png|jpe?g)$/i, '.webp');
    if (pictureSource) {
      pictureSource.srcset = webpUrl;
    }
    imgEl.src = data.url;
    imgEl.alt = data.name;
  }

  if (tagEl) {
    if (data.tag) {
      tagEl.textContent = data.tag;
      tagEl.className = `popup-type-tag ${data.tagClass || ''}`;
      tagEl.style.display = 'inline-block';
    } else {
      tagEl.style.display = 'none';
    }
  }

  if (titleEl) {
    titleEl.textContent = data.name;
  }

  if (blurbEl) {
    if (data.blurb && data.blurb.trim().length > 0) {
      blurbEl.innerHTML = data.blurb;
      blurbEl.style.display = 'block';
    } else {
      blurbEl.style.display = 'none';
      blurbEl.innerHTML = '';
    }
  }

  previousFocusedElement = document.activeElement as HTMLElement | null;

  modalEl.classList.add('is-open');
  modalEl.setAttribute('aria-hidden', 'false');
  document.body.classList.add('travel-modal-open');

  requestAnimationFrame(() => {
    closeBtn?.focus();
  });
}

export function closeImageModal(): void {
  const modalEl = document.getElementById('travel-image-modal');
  if (!modalEl || !modalEl.classList.contains('is-open')) return;

  modalEl.classList.remove('is-open');
  modalEl.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('travel-modal-open');

  if (previousFocusedElement && typeof previousFocusedElement.focus === 'function') {
    try {
      previousFocusedElement.focus();
    } catch (e) {}
  }
  previousFocusedElement = null;
}

export function initImageModal(): () => void {
  const modalEl = document.getElementById('travel-image-modal');
  if (!modalEl) return () => {};

  const backdrop = document.getElementById('travel-modal-backdrop');
  const closeBtn = document.getElementById('travel-modal-close-btn');
  const dialog = document.getElementById('travel-modal-dialog');

  const onBackdropClick = (e: MouseEvent) => {
    e.stopPropagation();
    closeImageModal();
  };

  const onCloseBtnClick = (e: MouseEvent) => {
    e.stopPropagation();
    closeImageModal();
  };

  const onDialogClick = (e: MouseEvent) => {
    e.stopPropagation();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && isImageModalOpen()) {
      e.preventDefault();
      e.stopPropagation();
      closeImageModal();
    }
  };

  backdrop?.addEventListener('click', onBackdropClick);
  closeBtn?.addEventListener('click', onCloseBtnClick);
  dialog?.addEventListener('click', onDialogClick);
  document.addEventListener('keydown', onKeyDown, true);

  return () => {
    backdrop?.removeEventListener('click', onBackdropClick);
    closeBtn?.removeEventListener('click', onCloseBtnClick);
    dialog?.removeEventListener('click', onDialogClick);
    document.removeEventListener('keydown', onKeyDown, true);
    closeImageModal();
  };
}
