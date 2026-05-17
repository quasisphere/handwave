/--
%%handwave
statement:
  Addition of natural numbers is associative.
proof.sketch:
  This follows from the standard associativity theorem for natural addition.
-/
theorem my_add_assoc (a b c : Nat) :
    (a + b) + c = a + (b + c) := by
  exact Nat.add_assoc a b c
