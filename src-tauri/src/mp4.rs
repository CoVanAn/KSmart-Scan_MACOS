use bytes::{Bytes, BytesMut, BufMut};

pub struct Mp4Segmenter {
    buffer: BytesMut,
    init_parts: Vec<Bytes>,
    init_done: bool,
    pending: Vec<Bytes>,
}

impl Mp4Segmenter {
    pub fn new() -> Self {
        Self {
            buffer: BytesMut::new(),
            init_parts: Vec::new(),
            init_done: false,
            pending: Vec::new(),
        }
    }

    pub fn write<F1, F2>(&mut self, chunk: &[u8], mut on_init: F1, mut on_segment: F2) 
    where 
        F1: FnMut(Bytes), 
        F2: FnMut(Bytes),
    {
        self.buffer.put_slice(chunk);

        loop {
            if self.buffer.len() < 8 {
                return;
            }

            let mut size = u32::from_be_bytes(self.buffer[0..4].try_into().unwrap()) as u64;
            let box_type = String::from_utf8_lossy(&self.buffer[4..8]).to_string();
            let mut header_size = 8;

            if size == 1 {
                if self.buffer.len() < 16 {
                    return;
                }
                let hi = u32::from_be_bytes(self.buffer[8..12].try_into().unwrap()) as u64;
                let lo = u32::from_be_bytes(self.buffer[12..16].try_into().unwrap()) as u64;
                size = hi * 4294967296 + lo;
                header_size = 16;
            } else if size == 0 {
                return;
            }

            if size < header_size || size > 256 * 1024 * 1024 {
                self.buffer.clear();
                return;
            }

            let size_usize = size as usize;
            if self.buffer.len() < size_usize {
                return;
            }

            let box_data = self.buffer.split_to(size_usize).freeze();
            self.handle_box(box_type.as_str(), box_data, &mut on_init, &mut on_segment);
        }
    }

    fn handle_box<F1, F2>(&mut self, box_type: &str, box_data: Bytes, on_init: &mut F1, on_segment: &mut F2) 
    where 
        F1: FnMut(Bytes), 
        F2: FnMut(Bytes),
    {
        if !self.init_done {
            if box_type == "ftyp" || box_type == "moov" {
                self.init_parts.push(box_data);
                if box_type == "moov" {
                    self.init_done = true;
                    let mut init_buf = BytesMut::new();
                    for part in self.init_parts.drain(..) {
                        init_buf.put(part);
                    }
                    on_init(init_buf.freeze());
                }
            }
            return;
        }

        if box_type == "moof" || box_type == "styp" {
            if box_type == "styp" {
                self.pending.clear();
                self.pending.push(box_data);
            } else {
                self.flush_if_complete();
                self.pending.push(box_data);
            }
            return;
        }

        if box_type == "mdat" {
            self.pending.push(box_data);
            self.flush(on_segment);
            return;
        }
    }

    fn flush_if_complete(&mut self) {
        if !self.pending.is_empty() {
            self.pending.clear();
        }
    }

    fn flush<F2>(&mut self, on_segment: &mut F2) 
    where 
        F2: FnMut(Bytes),
    {
        if self.pending.is_empty() {
            return;
        }
        let mut seg = BytesMut::new();
        for part in self.pending.drain(..) {
            seg.put(part);
        }
        on_segment(seg.freeze());
    }
}
