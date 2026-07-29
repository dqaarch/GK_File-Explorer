// Viewport-based thumbnail loading hook
// Only loads thumbnails for items that are visible in the viewport
// Implements Intersection Observer pattern like FilePilot/Windows Explorer

import { useEffect, useRef, useCallback, useState } from "react";

interface ViewportThumbnailsOptions {
  // Items to track
  items: Array<{ path: string; type: "file" | "directory" }>;
  // Existing thumbnails
  thumbnails: Record<string, string | null>;
  // Callback when new thumbnails are needed
  onLoadThumbnails: (paths: string[]) => void;
  // Debounce delay in ms
  debounceMs?: number;
  // Root margin for preloading (px)
  rootMargin?: number;
  // Batch size
  batchSize?: number;
}

export function useViewportThumbnails({
  items,
  thumbnails,
  onLoadThumbnails,
  debounceMs = 100,
  rootMargin = 200, // Preload 200px beyond viewport
  batchSize = 30, // Load 30 items at a time
}: ViewportThumbnailsOptions) {
  // Track which items have been observed at least once
  const [observedPaths, setObservedPaths] = useState<Set<string>>(new Set());
  // Track items in flight (loading) - also kept in ref for performance
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const loadingPathsRef = useRef<Set<string>>(new Set());

  const observerRef = useRef<IntersectionObserver | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const loadQueueRef = useRef<string[]>([]);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemsRef = useRef(items);
  const thumbnailsRef = useRef(thumbnails);
  const onLoadThumbnailsRef = useRef(onLoadThumbnails);

  // Keep refs in sync
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    thumbnailsRef.current = thumbnails;
  }, [thumbnails]);

  useEffect(() => {
    onLoadThumbnailsRef.current = onLoadThumbnails;
  }, [onLoadThumbnails]);

  // Process the load queue with debouncing
  const processQueue = useCallback(() => {
    const queue = loadQueueRef.current;
    if (queue.length === 0) return;

    // Take batch from queue
    const batch = queue.splice(0, batchSize);
    loadingPathsRef.current = new Set([...loadingPathsRef.current, ...batch]);
    setLoadingPaths(loadingPathsRef.current);

    // Call the load callback
    onLoadThumbnailsRef.current(batch);

    // Schedule next batch if queue has more
    if (queue.length > 0) {
      loadTimeoutRef.current = setTimeout(processQueue, debounceMs);
    }
  }, [batchSize, debounceMs]);

  // Queue paths for thumbnail loading
  const queueThumbnails = useCallback((paths: string[]) => {
    const currentThumbs = thumbnailsRef.current;
    const currentLoading = loadingPathsRef.current;

    // Filter out paths that already have thumbnails or are loading
    const newPaths = paths.filter(
      (p) => !currentThumbs[p] && !currentLoading.has(p) && !loadQueueRef.current.includes(p)
    );

    if (newPaths.length === 0) return;

    // Add to queue
    loadQueueRef.current.push(...newPaths);

    // Cancel existing timeout
    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
    }

    // Start processing with debounce
    loadTimeoutRef.current = setTimeout(processQueue, debounceMs);
  }, [debounceMs]);

  // Update loadingPaths when thumbnails become available - use ref to avoid re-render loop
  useEffect(() => {
    // Only update if there are actually items to remove from loadingPaths
    const currentLoading = loadingPathsRef.current;
    if (currentLoading.size === 0) return;
    
    let changed = false;
    currentLoading.forEach((p) => {
      if (thumbnails[p]) {
        currentLoading.delete(p);
        changed = true;
      }
    });
    // Don't trigger state update here - the component will re-render anyway
    // when thumbnails change, and we'll pick up the new state
  }, [thumbnails]);

  // Initialize Intersection Observer
  useEffect(() => {
    if (!containerRef.current) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        const visiblePaths: string[] = [];

        entries.forEach((entry) => {
          const path = (entry.target as HTMLElement).dataset.itemPath;
          if (!path) return;

          if (entry.isIntersecting) {
            // Item is visible - mark as observed and queue for loading
            setObservedPaths((prev) => {
              if (prev.has(path)) return prev;
              const next = new Set(prev);
              next.add(path);
              return next;
            });
            visiblePaths.push(path);
          }
        });

        // Queue visible items for thumbnail loading
        if (visiblePaths.length > 0) {
          queueThumbnails(visiblePaths);
        }
      },
      {
        root: containerRef.current,
        rootMargin: `${rootMargin}px`,
        threshold: 0.01,
      }
    );

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
      }
    };
  }, [rootMargin, queueThumbnails]);

  // Observe/unobserve items when they appear
  useEffect(() => {
    const observer = observerRef.current;
    if (!observer || !containerRef.current) return;

    const container = containerRef.current;
    const itemElements = container.querySelectorAll("[data-item-path]");

    itemElements.forEach((el) => {
      observer.observe(el);
    });

    return () => {
      itemElements.forEach((el) => {
        observer.unobserve(el);
      });
    };
  }, [items, observedPaths]);

  // Set container ref
  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
  }, []);

  // Get loading state for a path
  const isLoading = useCallback((path: string) => {
    return loadingPathsRef.current.has(path) && !thumbnailsRef.current[path];
  }, []);

  // Preload visible items on initial render
  useEffect(() => {
    if (items.length === 0) return;

    // Get file items that don't have thumbnails yet
    const currentLoading = loadingPathsRef.current;
    const fileItems = items.filter((item) => {
      return (
        item.type === "file" &&
        !thumbnails[item.path] &&
        !currentLoading.has(item.path)
      );
    });

    // Take first batch for initial load
    const initialBatch = fileItems.slice(0, batchSize).map((item) => item.path);

    if (initialBatch.length > 0) {
      loadingPathsRef.current = new Set([...currentLoading, ...initialBatch]);
      setLoadingPaths(loadingPathsRef.current);
      onLoadThumbnailsRef.current(initialBatch);
    }
  }, [items, thumbnails, batchSize]);

  return {
    setContainerRef,
    isLoading,
    observedPaths,
    loadingPaths,
  };
}
