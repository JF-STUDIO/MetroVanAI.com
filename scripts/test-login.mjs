
import { createClient } from "@supabase/supabase-js";
import * as readline from "readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function testLogin() {
  const supabaseUrl = await question("Enter your Supabase URL: ");
  const anonKey = await question("Enter your Supabase anon key: ");
  const email = await question("Enter your email: ");
  const password = await question("Enter your password: ");

  rl.close();

  if (!supabaseUrl || !anonKey || !email || !password) {
    console.error("All fields are required.");
    return;
  }

  const supabase = createClient(supabaseUrl.trim(), anonKey.trim());

  console.log(`\nAttempting to log in with ${email}...`);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password: password.trim(),
  });

  if (error) {
    console.error("Login FAILED:", error.message);
  } else {
    console.log("Login SUCCESSFUL! Your credentials are correct.");
    console.log("User data:", data);
  }
}

testLogin();
