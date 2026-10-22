use router_core::program_audio_ipc::{ProgramAudioStreamDecoder, project_program_audio_frame};
use std::io::{self, Read};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut decoder = ProgramAudioStreamDecoder::default();
    let mut buffer = [0_u8; 8192];
    loop {
        let bytes = io::stdin().read(&mut buffer)?;
        if bytes == 0 {
            break;
        }
        for frame in decoder.push(&buffer[..bytes])? {
            println!(
                "{}",
                serde_json::to_string(&project_program_audio_frame(&frame))?
            );
        }
    }
    decoder.finish()?;
    Ok(())
}
