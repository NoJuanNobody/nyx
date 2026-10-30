//! `nyx` command-line interface.

use clap::Parser;

/// Nyx: agent-native, open-source knowledge workspace.
#[derive(Parser, Debug)]
#[command(name = "nyx", version, about)]
struct Cli {}

fn main() {
    let _cli = Cli::parse();
    println!("{}", nyx_core::hello());
}
