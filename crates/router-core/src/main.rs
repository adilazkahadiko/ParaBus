use router_core::{CORE_IPC_MAX_LINE_BYTES, CoreState};
use std::io::{self, BufRead, Write};

fn read_bounded_line(
    reader: &mut impl BufRead,
    limit: usize,
) -> io::Result<Option<Result<Vec<u8>, ()>>> {
    let mut line = Vec::new();
    let mut too_large = false;
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return if line.is_empty() && !too_large {
                Ok(None)
            } else if too_large {
                Ok(Some(Err(())))
            } else {
                Ok(Some(Ok(line)))
            };
        }
        let end = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(buffer.len(), |index| index + 1);
        let terminated = buffer[end - 1] == b'\n';
        let payload_bytes = end - usize::from(terminated);
        if !too_large {
            if line.len() + payload_bytes > limit {
                too_large = true;
                line.clear();
            } else {
                line.extend_from_slice(&buffer[..end]);
            }
        }
        reader.consume(end);
        if terminated {
            return if too_large {
                Ok(Some(Err(())))
            } else {
                if line.last() == Some(&b'\n') {
                    line.pop();
                }
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                Ok(Some(Ok(line)))
            };
        }
    }
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdin = stdin.lock();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    let mut core = CoreState::default();

    while let Some(line) = read_bounded_line(&mut stdin, CORE_IPC_MAX_LINE_BYTES)? {
        match line {
            Err(()) => writeln!(
                stdout,
                "{{\"v\":1,\"id\":\"\",\"type\":\"error\",\"ok\":false,\"error\":\"request line is too large\"}}"
            )?,
            Ok(line) => match std::str::from_utf8(&line) {
                Ok(line) if !line.trim().is_empty() => {
                    writeln!(stdout, "{}", core.handle_line(line))?;
                }
                Ok(_) => continue,
                Err(_) => writeln!(
                    stdout,
                    "{{\"v\":1,\"id\":\"\",\"type\":\"error\",\"ok\":false,\"error\":\"request is not valid UTF-8\"}}"
                )?,
            },
        }
        stdout.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn bounded_reader_discards_an_oversized_line_and_recovers() {
        let mut input = vec![b'x'; 12];
        input.extend_from_slice(b"\nOK\n");
        let mut reader = Cursor::new(input);
        assert_eq!(read_bounded_line(&mut reader, 8).unwrap(), Some(Err(())));
        assert_eq!(
            read_bounded_line(&mut reader, 8).unwrap(),
            Some(Ok(b"OK".to_vec()))
        );
        assert_eq!(read_bounded_line(&mut reader, 8).unwrap(), None);
    }

    #[test]
    fn bounded_reader_preserves_an_empty_line() {
        let mut reader = Cursor::new(b"\n".to_vec());
        assert_eq!(
            read_bounded_line(&mut reader, 8).unwrap(),
            Some(Ok(Vec::new()))
        );
    }
}
