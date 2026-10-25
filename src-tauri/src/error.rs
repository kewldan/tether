use serde::{Serialize, Serializer};

/// Errors returned to the frontend as `{ kind, message, hint? }`.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("adb executable was not found")]
    AdbNotFound,
    #[error("failed to start adb server: {0}")]
    ServerStart(String),
    #[error("adb server is not reachable: {0}")]
    ServerUnreachable(#[source] std::io::Error),
    #[error("adb server refused the request: {0}")]
    AdbFailure(String),
    #[error("malformed response from adb server: {0}")]
    Protocol(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl AppError {
    fn kind(&self) -> &'static str {
        match self {
            Self::AdbNotFound => "adb_not_found",
            Self::ServerStart(_) => "server_start",
            Self::ServerUnreachable(_) => "server_unreachable",
            Self::AdbFailure(_) => "adb_failure",
            Self::Protocol(_) => "protocol",
            Self::Io(_) => "io",
        }
    }

    fn hint(&self) -> Option<&'static str> {
        match self {
            Self::AdbNotFound => {
                Some("Install Android platform-tools or point the app to an existing adb binary.")
            }
            Self::ServerStart(_) | Self::ServerUnreachable(_) => {
                Some("Check that nothing else occupies port 5037 and that adb can be launched.")
            }
            _ => None,
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;

        let mut s = serializer.serialize_struct("AppError", 3)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        s.serialize_field("hint", &self.hint())?;
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
