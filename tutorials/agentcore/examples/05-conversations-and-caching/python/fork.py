"""Write a short thread, then fork it: the user edits their second question."""

import uuid

from memory import add_message, read_thread

user_id = "usr_7f3a9c"  # key memory by a stable user id (tutorial 06 takes it from the token)
session_id = str(uuid.uuid4())

add_message(user_id, session_id, "USER", "What is the hotel limit per night?")
answer = add_message(user_id, session_id, "ASSISTANT", "Up to 180 EUR in major cities.")
add_message(user_id, session_id, "USER", "Is Paris a major city?")
add_message(user_id, session_id, "ASSISTANT", "Yes.")

# Fork after the first answer: the second question becomes "Is Lyon a major city?".
add_message(user_id, session_id, "USER", "Is Lyon a major city?", branch="lyon", fork_from=answer)
add_message(user_id, session_id, "ASSISTANT", "Yes.", branch="lyon")

print("main:", read_thread(user_id, session_id))
print("lyon:", read_thread(user_id, session_id, branch="lyon"))
