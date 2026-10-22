use router_core::discord_ipc::{DiscordStreamDecoder, project_discord_frame};
use std::io::{self, Read, Write};

const READ_BUFFER_BYTES: usize = 16 * 1024;

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut output = io::BufWriter::new(stdout.lock());
    let mut decoder = DiscordStreamDecoder::default();
    let mut buffer = [0_u8; READ_BUFFER_BYTES];

    loop {
        let bytes = input.read(&mut buffer)?;
        if bytes == 0 {
            break;
        }
        let frames = decoder.push(&buffer[..bytes]).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Discord shadow decode failed: {error}"),
            )
        })?;
        for frame in frames {
            if !frame.is_metadata() {
                continue;
            }
            serde_json::to_writer(&mut output, &project_discord_frame(&frame))?;
            output.write_all(b"\n")?;
        }
        output.flush()?;
    }

    if decoder.buffered_bytes() != 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Discord shadow input ended with a partial frame",
        ));
    }
    Ok(())
}
