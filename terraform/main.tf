# Read information about the existing EC2 instance
data "aws_instance" "existing" {
  instance_id = var.instance_id
}

# Read information about the existing VPC
data "aws_vpc" "existing" {
  id = var.vpc_id
}

# Read information about the existing subnet
data "aws_subnet" "existing" {
  id = var.subnet_id
}

# Read information about the existing security group
data "aws_security_group" "existing" {
  id = var.security_group_id
}

# Read information about the five existing ECR repositories
data "aws_ecr_repository" "existing" {
  for_each = toset(var.ecr_repository_names)
  name     = each.value
}
