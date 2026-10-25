//! Codecs for ai-file, compiled to WebAssembly.
//!
//! The ABI is plain C so the module needs no generated glue. Large data never has to live in
//! wasm memory at once: every codec pulls its input through the imported `js_read` and pushes its
//! output through `js_write`, in chunks, while JavaScript keeps the buffers.
//!
//! Every exported operation returns 0 on success or a negative code; `error_ptr`/`error_len`
//! then describe the last error.

use std::io::{self, Read, Write};

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
unsafe extern "C" {
    /// Copies up to `len` bytes of the current input to `ptr`; returns the count (0 = end).
    fn js_read(ptr: *mut u8, len: usize) -> usize;
    /// Appends `len` bytes at `ptr` to the current output.
    fn js_write(ptr: *const u8, len: usize);
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn js_read(_: *mut u8, _: usize) -> usize {
    0
}
#[cfg(not(target_arch = "wasm32"))]
unsafe fn js_write(_: *const u8, _: usize) {}

const CHUNK: usize = 1 << 20;

thread_local! {
    static LAST_ERROR: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}

fn fail(code: i32, msg: impl Into<String>) -> i32 {
    LAST_ERROR.with(|e| *e.borrow_mut() = msg.into());
    code
}

#[unsafe(no_mangle)]
pub extern "C" fn error_ptr() -> *const u8 {
    LAST_ERROR.with(|e| e.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn error_len() -> usize {
    LAST_ERROR.with(|e| e.borrow().len())
}

// ----------------------------------------------------------------------------- memory

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` must come from `alloc(len)` and not have been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len.max(1)) });
}

// ----------------------------------------------------------------------------- JS I/O

struct JsIn;
impl Read for JsIn {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        Ok(unsafe { js_read(buf.as_mut_ptr(), buf.len()) })
    }
}

struct JsOut;
impl Write for JsOut {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if !buf.is_empty() {
            unsafe { js_write(buf.as_ptr(), buf.len()) };
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn out(buf: &[u8]) {
    let _ = JsOut.write(buf);
}

// ----------------------------------------------------------------------------- zstd

/// Decompresses a zstd stream (libzstd; concatenated and skippable frames are handled).
#[unsafe(no_mangle)]
pub extern "C" fn zstd_decompress() -> i32 {
    let mut dec = match zstd::stream::read::Decoder::with_buffer(io::BufReader::with_capacity(CHUNK, JsIn)) {
        Ok(d) => d,
        Err(e) => return fail(-3, format!("zstd: {e}")),
    };
    match io::copy(&mut dec, &mut io::BufWriter::with_capacity(CHUNK, JsOut)) {
        Ok(_) => 0,
        Err(e) => fail(-3, format!("zstd: {e}")),
    }
}

/// Compresses the input into a single zstd frame at `level` (1..=22, 3 is zstd's default).
#[unsafe(no_mangle)]
pub extern "C" fn zstd_compress(level: i32) -> i32 {
    let run = || -> io::Result<()> {
        let mut enc = zstd::stream::write::Encoder::new(io::BufWriter::with_capacity(CHUNK, JsOut), level)?;
        io::copy(&mut io::BufReader::with_capacity(CHUNK, JsIn), &mut enc)?;
        enc.finish()?.flush()
    };
    match run() {
        Ok(()) => 0,
        Err(e) => fail(-3, format!("zstd: {e}")),
    }
}

// ----------------------------------------------------------------------------- zlib / deflate

/// Compresses the input with deflate. `zlib_header` 1 = zlib framing (RFC 1950), 0 = raw.
#[unsafe(no_mangle)]
pub extern "C" fn deflate(level: i32, zlib_header: i32) -> i32 {
    use zlib_rs::{Deflate, DeflateFlush, Status};
    let mut z = Deflate::new(level.clamp(0, 9), zlib_header != 0, 15);
    let mut input = vec![0u8; CHUNK];
    let mut output = vec![0u8; CHUNK];
    loop {
        let n = unsafe { js_read(input.as_mut_ptr(), CHUNK) };
        let flush = if n == 0 { DeflateFlush::Finish } else { DeflateFlush::NoFlush };
        let mut src = &input[..n];
        loop {
            let (in0, out0) = (z.total_in(), z.total_out());
            let status = match z.compress(src, &mut output, flush) {
                Ok(s) => s,
                Err(e) => return fail(-4, format!("deflate: {}", e.as_str())),
            };
            src = &src[(z.total_in() - in0) as usize..];
            let produced = (z.total_out() - out0) as usize;
            out(&output[..produced]);
            if status == Status::StreamEnd {
                return 0;
            }
            // More input is needed once this chunk is consumed and the output was not full.
            if flush == DeflateFlush::NoFlush && src.is_empty() && produced < output.len() {
                break;
            }
        }
    }
}

/// Decompresses deflate data. `zlib_header` 1 = zlib, 0 = raw, -1 = detect from the first byte.
/// Stops at the end of the stream; trailing bytes are ignored (PDF streams often have them).
#[unsafe(no_mangle)]
pub extern "C" fn inflate(zlib_header: i32) -> i32 {
    use zlib_rs::{Inflate, InflateFlush, Status};
    let mut input = vec![0u8; CHUNK];
    let mut output = vec![0u8; CHUNK];
    let mut n = unsafe { js_read(input.as_mut_ptr(), CHUNK) };
    if n == 0 {
        return 0;
    }
    let header = if zlib_header >= 0 { zlib_header != 0 } else { input[0] & 0x0f == 8 && (u16::from(input[0]) << 8 | u16::from(input[1])) % 31 == 0 };
    let mut z = Inflate::new(header, 15);
    loop {
        let mut src = &input[..n];
        loop {
            let (in0, out0) = (z.total_in(), z.total_out());
            let status = match z.decompress(src, &mut output, InflateFlush::NoFlush) {
                Ok(s) => s,
                Err(e) => return fail(-5, format!("inflate: {}", e.as_str())),
            };
            src = &src[(z.total_in() - in0) as usize..];
            let produced = (z.total_out() - out0) as usize;
            out(&output[..produced]);
            if status == Status::StreamEnd {
                return 0;
            }
            if src.is_empty() || (produced == 0 && z.total_in() == in0) {
                break;
            }
        }
        n = unsafe { js_read(input.as_mut_ptr(), CHUNK) };
        if n == 0 {
            // Truncated stream: keep what was decoded (matches lenient PDF readers).
            return 0;
        }
    }
}

// ----------------------------------------------------------------------------- rasters

/// Illustrator raster samples: `w*h*channels` interleaved color bytes followed by one `w*h`
/// alpha plane. Output modes:
///   0 = RGBA (out_w*out_h*4)
///   1 = PNG (RGBA, deflate level `level`)
///   2 = RGB plane followed by an alpha plane (only when `has_alpha`), for PDF image XObjects
/// The image is resampled (nearest neighbour) to out_w × out_h.
///
/// # Safety
/// `src` must point to `src_len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn raster(
    src: *const u8,
    src_len: usize,
    w: u32,
    h: u32,
    channels: u32,
    has_alpha: i32,
    out_w: u32,
    out_h: u32,
    mode: i32,
    level: i32,
) -> i32 {
    let src = unsafe { std::slice::from_raw_parts(src, src_len) };
    let (w, h, ch) = (w as usize, h as usize, channels as usize);
    let (ow, oh) = (out_w.max(1) as usize, out_h.max(1) as usize);
    let color = w * h * ch;
    if !(1..=4).contains(&ch) || src_len < color {
        return fail(-6, "raster: not enough samples");
    }
    let alpha = if has_alpha != 0 && src_len >= color + w * h { Some(&src[color..color + w * h]) } else { None };
    let xs: Vec<usize> = (0..ow).map(|x| (((x as f64 + 0.5) * w as f64 / ow as f64) as usize).min(w - 1)).collect();
    let pixel = |sy: usize, sx: usize| -> [u8; 4] {
        let i = (sy * w + sx) * ch;
        let a = alpha.map_or(255, |p| p[sy * w + sx]);
        match ch {
            3 => [src[i], src[i + 1], src[i + 2], a],
            4 => {
                // Same naive conversion as model/color.ts cmykToRgb.
                let k = 1.0 - f32::from(src[i + 3]) / 255.0;
                let f = |c: u8| ((1.0 - f32::from(c) / 255.0) * k * 255.0) as u8;
                [f(src[i]), f(src[i + 1]), f(src[i + 2]), a]
            }
            _ => [src[i], src[i], src[i], a],
        }
    };
    let rows = (0..oh).map(|y| (((y as f64 + 0.5) * h as f64 / oh as f64) as usize).min(h - 1));
    match mode {
        0 => {
            let mut row = vec![0u8; ow * 4];
            for sy in rows {
                for (x, &sx) in xs.iter().enumerate() {
                    row[x * 4..x * 4 + 4].copy_from_slice(&pixel(sy, sx));
                }
                out(&row);
            }
            0
        }
        1 => {
            let mut row = vec![0u8; ow * 4];
            let mut rows = rows;
            write_png(ow, oh, level, |buf| {
                let sy = rows.next().unwrap_or(0);
                for (x, &sx) in xs.iter().enumerate() {
                    row[x * 4..x * 4 + 4].copy_from_slice(&pixel(sy, sx));
                }
                buf.copy_from_slice(&row);
            })
        }
        2 => {
            let rows: Vec<usize> = rows.collect();
            let mut row = vec![0u8; ow * 3];
            for &sy in &rows {
                for (x, &sx) in xs.iter().enumerate() {
                    row[x * 3..x * 3 + 3].copy_from_slice(&pixel(sy, sx)[..3]);
                }
                out(&row);
            }
            if alpha.is_some() {
                let mut row = vec![0u8; ow];
                for &sy in &rows {
                    for (x, &sx) in xs.iter().enumerate() {
                        row[x] = pixel(sy, sx)[3];
                    }
                    out(&row);
                }
            }
            0
        }
        _ => fail(-6, "raster: unknown mode"),
    }
}

/// Encodes RGBA rows produced by `next_row` as a PNG through `js_write`.
fn write_png(w: usize, h: usize, level: i32, mut next_row: impl FnMut(&mut [u8])) -> i32 {
    let mut enc = png::Encoder::new(JsOut, w as u32, h as u32);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.set_compression(match level {
        ..=0 => png::Compression::NoCompression,
        1..=3 => png::Compression::Fastest,
        4..=6 => png::Compression::Fast,
        7..=8 => png::Compression::Balanced,
        _ => png::Compression::High,
    });
    enc.set_filter(png::Filter::Up);
    let run = || -> Result<(), String> {
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        let mut stream = writer.stream_writer_with_size(CHUNK).map_err(|e| e.to_string())?;
        let mut row = vec![0u8; w * 4];
        for _ in 0..h {
            next_row(&mut row);
            stream.write_all(&row).map_err(|e| e.to_string())?;
        }
        stream.finish().map_err(|e| e.to_string())
    };
    match run() {
        Ok(()) => 0,
        Err(e) => fail(-7, format!("png: {e}")),
    }
}

/// Encodes 8-bit RGBA pixels as a PNG.
///
/// # Safety
/// `src` must point to `w*h*4` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn png_rgba(src: *const u8, w: u32, h: u32, level: i32) -> i32 {
    let (w, h) = (w as usize, h as usize);
    let src = unsafe { std::slice::from_raw_parts(src, w * h * 4) };
    let mut y = 0;
    write_png(w, h, level, |row| {
        row.copy_from_slice(&src[y * w * 4..(y + 1) * w * 4]);
        y += 1;
    })
}
