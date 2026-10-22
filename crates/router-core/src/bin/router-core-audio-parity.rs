use router_core::audio_parity::{AudioBlockRequest, AudioParityCore};
use router_core::realtime_graph::{TopologyBlockRequest, process_topology_block};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, BufRead, Write};

const MAX_LINE_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
struct Request {
    v: u8,
    id: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Serialize)]
struct Response {
    v: u8,
    id: String,
    #[serde(rename = "type")]
    kind: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl Response {
    fn error(id: String, kind: String, error: impl Into<String>) -> Self {
        Self {
            v: 1,
            id,
            kind,
            ok: false,
            payload: None,
            error: Some(error.into()),
        }
    }
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdin = stdin.lock();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    let mut core = AudioParityCore::default();

    while let Some(line) = read_bounded_line(&mut stdin, MAX_LINE_BYTES)? {
        let response = match line {
            Err(()) => Response::error(
                String::new(),
                "error".to_owned(),
                "request line is too large",
            ),
            Ok(line) => match std::str::from_utf8(&line) {
                Ok(line) if !line.trim().is_empty() => handle_line(&mut core, line),
                Ok(_) => continue,
                Err(_) => Response::error(
                    String::new(),
                    "error".to_owned(),
                    "request is not valid UTF-8",
                ),
            },
        };
        serde_json::to_writer(&mut stdout, &response)?;
        writeln!(stdout)?;
        stdout.flush()?;
    }
    Ok(())
}

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

fn handle_line(core: &mut AudioParityCore, line: &str) -> Response {
    let request = match serde_json::from_str::<Request>(line) {
        Ok(request) => request,
        Err(error) => {
            return Response::error(String::new(), "error".to_owned(), error.to_string());
        }
    };
    if request.v != 1 {
        return Response::error(request.id, request.kind, "unsupported protocol version");
    }
    let result = match request.kind.as_str() {
        "process_block" => serde_json::from_value::<AudioBlockRequest>(request.payload)
            .map_err(|error| error.to_string())
            .and_then(|payload| core.process_block(payload))
            .and_then(|result| serde_json::to_value(result).map_err(|error| error.to_string())),
        "process_topology_block" => serde_json::from_value::<TopologyBlockRequest>(request.payload)
            .map_err(|error| error.to_string())
            .and_then(process_topology_block)
            .and_then(|result| serde_json::to_value(result).map_err(|error| error.to_string())),
        _ => return Response::error(request.id, request.kind, "unknown request type"),
    };
    match result {
        Ok(payload) => Response {
            v: 1,
            id: request.id,
            kind: request.kind,
            ok: true,
            payload: Some(payload),
            error: None,
        },
        Err(error) => Response::error(request.id, request.kind, error),
    }
}
