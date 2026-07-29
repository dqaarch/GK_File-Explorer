// EPUB Reader Module - Extract metadata, cover, and text content from EPUB files

use std::io::Cursor;
use std::path::Path;

use base64::Engine;
use epub_parser::Epub;

const MAX_TEXT_LENGTH: usize = 50000;
const COVER_MAX_SIZE: usize = 1024;

#[derive(Debug, serde::Serialize)]
pub struct EpubDecodeResult {
    pub success: bool,
    pub title: Option<String>,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub description: Option<String>,
    pub cover_base64: Option<String>,
    pub cover_width: Option<u32>,
    pub cover_height: Option<u32>,
    pub table_of_contents: Vec<TocEntry>,
    pub text_content: Option<String>, // Combined text (for quick preview)
    pub chapters: Vec<ChapterContent>, // Individual chapter content
    pub chapters_count: usize,
    pub error: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct ChapterContent {
    pub index: usize,
    pub title: Option<String>,
    pub href: Option<String>,
    pub content: String,
}

#[derive(Debug, serde::Serialize)]
pub struct TocEntry {
    pub title: String,
    pub href: String,
    pub level: u32,
}

pub fn decode_epub(path: &Path) -> EpubDecodeResult {
    println!("[EPUB] decode_epub: Starting...");
    let epub = match Epub::parse(path) {
        Ok(e) => {
            println!("[EPUB] EPUB parsed successfully");
            e
        }
        Err(e) => {
            return EpubDecodeResult {
                success: false,
                title: None,
                author: None,
                publisher: None,
                language: None,
                description: None,
                cover_base64: None,
                cover_width: None,
                cover_height: None,
                table_of_contents: vec![],
                text_content: None,
                chapters: vec![],
                chapters_count: 0,
                error: Some(format!("Failed to parse EPUB: {}", e)),
            };
        }
    };

    let title = epub.metadata.title.clone();
    let author = epub.metadata.author.clone();
    let publisher = epub.metadata.publisher.clone();
    let language = epub.metadata.language.clone();
    println!("[EPUB] Metadata: title={:?}", title);

    println!("[EPUB] Calling extract_cover...");
    let (cover_base64, cover_width, cover_height) = extract_cover(&epub);
    println!("[EPUB] extract_cover done");
    
    println!("[EPUB] Calling extract_toc...");
    let table_of_contents = extract_toc(&epub);
    println!("[EPUB] extract_toc done, {} entries", table_of_contents.len());
    
    println!("[EPUB] Calling extract_text_content...");
    let (text_content, chapters_count) = extract_text_content(&epub);
    println!("[EPUB] extract_text_content done");
    
    println!("[EPUB] Calling extract_chapters...");
    let chapters = extract_chapters(&epub);
    println!("[EPUB] extract_chapters done, {} chapters", chapters.len());

    println!("[EPUB] Decoded: {} chapters", chapters_count);

    EpubDecodeResult {
        success: true,
        title,
        author,
        publisher,
        language,
        description: None,
        cover_base64,
        cover_width,
        cover_height,
        table_of_contents,
        text_content,
        chapters,
        chapters_count,
        error: None,
    }
}

fn extract_cover(epub: &Epub) -> (Option<String>, Option<u32>, Option<u32>) {
    let images_count = epub.images.len();
    println!("[EPUB] extract_cover: images count = {}", images_count);
    if images_count == 0 {
        println!("[EPUB] extract_cover: No images found");
        return (None, None, None);
    }
    let cover_image = &epub.images[0];
    println!("[EPUB] extract_cover: Found image, size = {}", cover_image.content.len());

    let img = match image::load_from_memory(&cover_image.content) {
        Ok(img) => img,
        Err(e) => {
            println!("[EPUB] Failed to decode cover: {}", e);
            return (None, None, None);
        }
    };

    let (orig_w, orig_h) = (img.width(), img.height());

    let final_img = if orig_w > COVER_MAX_SIZE as u32 || orig_h > COVER_MAX_SIZE as u32 {
        let scale = (COVER_MAX_SIZE as f32 / orig_w.max(orig_h) as f32).min(1.0);
        let new_w = (orig_w as f32 * scale) as u32;
        let new_h = (orig_h as f32 * scale) as u32;
        image::imageops::resize(&img.to_rgb8(), new_w, new_h, image::imageops::FilterType::Lanczos3)
    } else {
        img.to_rgb8()
    };

    let mut png_bytes = Vec::new();
    if final_img.write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png).is_err() {
        return (None, None, None);
    }

    let b64_str = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    (Some(b64_str), Some(orig_w), Some(orig_h))
}

fn extract_toc(epub: &Epub) -> Vec<TocEntry> {
    epub.toc.iter().map(|item| TocEntry {
        title: item.label.clone(),
        href: item.href.clone(),
        level: 1,
    }).collect()
}

fn extract_text_content(epub: &Epub) -> (Option<String>, usize) {
    let chapters_count = epub.pages.len();
    if chapters_count == 0 {
        return (None, 0);
    }

    let mut full_text = String::new();
    let mut char_count = 0;
    let mut pages_processed = 0;

    for page in epub.pages.iter().take(10) {
        // Skip empty pages
        if page.content.is_empty() {
            println!("[EPUB] Skipping empty page");
            continue;
        }
        
        // page.content is already a String from epub-parser
        // Clone it to avoid borrow issues
        let content = page.content.clone();
        
        if char_count + content.len() > MAX_TEXT_LENGTH {
            let remaining = MAX_TEXT_LENGTH - char_count;
            if remaining > 0 {
                let partial: String = content.chars().take(remaining).collect();
                full_text.push_str(&partial);
            }
            break;
        }
        full_text.push_str(&content);
        full_text.push_str("\n\n--- Page Break ---\n\n");
        char_count = full_text.len();
        pages_processed += 1;
    }

    println!("[EPUB] extract_text_content: processed {} pages, {} chars", pages_processed, full_text.len());

    let cleaned = cleanup_text(&full_text);
    (Some(cleaned), chapters_count)
}

fn extract_chapters(epub: &Epub) -> Vec<ChapterContent> {
    let page_count = epub.pages.len();
    if page_count == 0 {
        return vec![];
    }

    let mut chapters = Vec::new();
    
    // Try to match TOC entries with pages via index
    // TOC entries should correspond to pages in order
    for (index, page) in epub.pages.iter().enumerate().take(50) {
        let mut title: Option<String> = None;
        let href: Option<String> = None;
        
        // Try to find matching TOC entry by index
        if index < epub.toc.len() {
            let toc_entry = &epub.toc[index];
            title = Some(toc_entry.label.clone());
        }
        
        // Fallback: generate title from page index
        let chapter_title = title.unwrap_or_else(|| {
            format!("Chapter {}", index + 1)
        });
        
        let content = cleanup_text(&page.content);
        
        // Only include chapters with actual content
        if !content.trim().is_empty() {
            chapters.push(ChapterContent {
                index,
                title: Some(chapter_title),
                href,
                content,
            });
        }
    }
    
    println!("[EPUB] extract_chapters: {} chapters with content", chapters.len());
    chapters
}

fn cleanup_text(text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut result = String::with_capacity(text.len());
    let mut prev_was_newline = false;

    for ch in text.chars() {
        if ch == '\n' {
            if !prev_was_newline {
                result.push('\n');
                result.push('\n');
                prev_was_newline = true;
            }
        } else {
            result.push(ch);
            prev_was_newline = false;
        }
    }
    result.trim().to_string()
}
